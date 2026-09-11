# @repo/api

The single HTTP API every frontend consumes. Hono on Bun.

| Path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe: the process answers HTTP. Always `200 { "status": "ok" }` |
| `GET /readyz` | Readiness probe: the database answers too (`select 1`, 2 s budget). `200 { "status": "ok", "checks": { "database": "ok" } }` or `503 { "status": "unavailable", "checks": { "database": "timeout" \| "unreachable" } }` |
| `POST /rpc/*` | oRPC transport used by the TypeScript clients (`@repo/api-client`) |
| `/api/v1/*` | The same procedures as plain REST |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 document generated from `@repo/api-contract` |
| `/api/auth/*` | Better Auth — sessions, passkeys, two-factor and the platform admin |

Point container restart policies at `/healthz` and traffic routing (Caddy, load balancers) at
`/readyz`: a Postgres restart flips `/readyz` to 503 without restarting the API, which is the
behaviour you want from each. Successful probe requests are kept out of the access log. The probe is
public, so the 503 body names only *what* failed (`timeout` when the 2 s budget ran out,
`unreachable` otherwise); what Postgres actually said — a password, a host, `too many clients
already` — goes to the log as `readiness check failed`. Concurrent probes share one `select 1`
(bounded by a server-side `statement_timeout`), so polling a hung database costs one connection, not
one per poll.

```sh
cp ../../.env.example ../../.env      # once
bun run dev                            # http://localhost:3000, hot reload
bun test
bun run openapi                        # writes ./openapi.json for client generation
```

Add a procedure: declare it in `packages/api-contract` and implement it in `src/rpc/router.ts`.
Every client is type-checked against the contract, and the REST/OpenAPI surface updates
automatically.

## Operations

### Logs

Everything goes through `src/log.ts` (`log.info(message, fields)`, `log.with({ component })`), never
`console.*`. Two formats, chosen by `LOG_FORMAT` — `json` in production, `pretty` elsewhere — and a
floor set by `LOG_LEVEL`:

```
{"time":"2026-09-09T23:10:04.118Z","level":"info","msg":"request","requestId":"6f1c…","method":"GET","path":"/api/v1/health","procedure":"system.health","component":"http","status":200,"durationMs":1.2,"ip":"127.0.0.1"}
23:10:04 info  request requestId=6f1c… method=GET path=/api/v1/health procedure=system.health component=http status=200 durationMs=1.2 ip=127.0.0.1
```

`debug`/`info` go to stdout, `warn`/`error` to stderr; `debug` is dropped in production unless
`LOG_LEVEL` says otherwise. Every response carries `X-Request-Id` (a well-formed incoming one is
kept, so Caddy's id follows the request through), and the same id is on *every* line written while
that request is being handled — the access-log line, `procedure failed`, `unhandled error`, anything
a service call logs — because the middleware opens a log context (`withLogContext`) that the logger
merges in; procedure lines also carry `procedure` (`documents.list`). A 500 body repeats the id
(`{ "error": "internal_error", "requestId": … }`) so a report can quote it. Access-log lines use
`warn` for 4xx and `error` for 5xx, so a `warn`-and-up view still shows every failing request.
`Error` fields serialise as `{ name, message, stack, …own fields }`; when a trace is active the line
also carries `traceId`/`spanId`.

### Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. `http://otel-collector:4318`) and the API exports spans
over OTLP/HTTP with the standard OpenTelemetry SDK — unset, the SDK is never loaded and every
tracer call is a no-op. What you get per trace: a server span per request (`GET /api/v1/health`,
via `@hono/otel`; `traceparent` from Caddy or a client is honoured). `OTEL_SERVICE_NAME` overrides
`service.name` (`starterdough-api`); `OTEL_EXPORTER_OTLP_HEADERS` carries auth for hosted backends.
The probes (`/healthz`, `/readyz`) are not traced, `url.full` on server spans carries no query
string (verification tokens and OAuth codes stay out of the backend), and SDK trouble such as a
refused export shows up in the log as `component=otel` at `warn`/`error`.

To look at traces locally, run a collector that prints what it receives and point the API at it
(the image's default config only listens on the container's own loopback, so it needs a config):

```yaml
# otel-debug.yaml
receivers: { otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } } }
exporters: { debug: { verbosity: detailed } }
service: { pipelines: { traces: { receivers: [otlp], exporters: [debug] } } }
```

```sh
docker run --rm -p 4318:4318 -v "$PWD/otel-debug.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest --config /etc/otelcol/config.yaml
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run dev     # spans appear in the collector's output
```

### Shutdown and pool size

An unhandled rejection or uncaught exception is logged (`unhandled rejection` / `uncaught
exception`) and exits 1: the process is in a state nothing can reason about, so the supervisor
restarts it rather than let it serve from half-broken state.

`SIGTERM`/`SIGINT` stop the listener, give in-flight requests 10 s, then force-close what is left,
flush spans (3 s at most: an unreachable collector must not stall the exit), close the database
pool (1 s) and exit 0. The three budgets add up to under compose's `stop_grace_period` (15 s), so
the pool is closed before the SIGKILL.

Each API process holds up to `DATABASE_POOL_MAX` connections (default 10). Postgres refuses
connections past `max_connections` (100 by default): keep
`api replicas × pool + migrate + backup + headroom` below it. The pool survives `bun --hot`
reloads, so changing `DATABASE_URL` or `DATABASE_POOL_MAX` needs a restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_FORMAT` | `json` in production, `pretty` otherwise | Log line format |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | Lowest level written (`debug`/`info`/`warn`/`error`) |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For` (set it where Caddy/an LB fronts the API) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset: tracing off)* | OTLP/HTTP collector base URL |
| `DATABASE_POOL_MAX` | `10` | Postgres connections per process |
| `OTEL_SERVICE_NAME` | `starterdough-api` | `service.name` on spans |
