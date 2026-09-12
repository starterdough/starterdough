# @repo/api

The single HTTP API every frontend uses. Hono on Bun.

| Path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe. Always `200 { "status": "ok" }` |
| `GET /readyz` | Readiness probe: the database must answer `select 1` within 2 s. `200 { "status": "ok", "checks": { "database": "ok" } }` or `503 { "status": "unavailable", "checks": { "database": "timeout" \| "unreachable" } }` |
| `POST /rpc/*` | oRPC transport used by the TypeScript clients (`@repo/api-client`) |
| `/api/v1/*` | The same procedures as plain REST |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 document generated from `@repo/api-contract` |
| `/api/auth/*` | Better Auth: sessions, passkeys, two-factor and the platform admin |

Point container restart policies at `/healthz` and traffic routing (Caddy, load balancers) at
`/readyz`. A Postgres restart turns `/readyz` into a 503 without restarting the API.

The probes are public, so a 503 body names only the failing check (`timeout` or `unreachable`).
What Postgres said goes to the log as `readiness check failed`. Concurrent probes share one
`select 1`, so polling a hung database costs one connection. Successful probe requests stay out of
the access log.

## Develop

```sh
cp ../../.env.example ../../.env      # once
bun run dev                            # http://localhost:3000, hot reload
bun test
bun run openapi                        # writes ./openapi.json
```

## Add a procedure

1. Declare it in `packages/api-contract`.
2. Implement it in `src/rpc/router.ts`.

Every client is type-checked against the contract. The REST and OpenAPI surface updates
automatically.

## Operations

### Logs

Everything logs through `src/log.ts` (`log.info(message, fields)`, `log.with({ component })`),
never `console.*`. `LOG_FORMAT` picks the format (`json` in production, `pretty` elsewhere).
`LOG_LEVEL` sets the floor:

```
{"time":"2026-09-09T23:10:04.118Z","level":"info","msg":"request","requestId":"6f1c…","method":"GET","path":"/api/v1/health","procedure":"system.health","component":"http","status":200,"durationMs":1.2,"ip":"127.0.0.1"}
23:10:04 info  request requestId=6f1c… method=GET path=/api/v1/health procedure=system.health component=http status=200 durationMs=1.2 ip=127.0.0.1
```

- `debug` and `info` go to stdout, `warn` and `error` to stderr. `debug` is dropped in production
  unless `LOG_LEVEL` says otherwise.
- Every response carries `X-Request-Id`. A well-formed incoming id is kept, so Caddy's id follows
  the request through.
- Every line written while a request is handled carries that `requestId` (`withLogContext` in the
  middleware). Procedure lines also carry `procedure`, for example `documents.list`.
- A 500 body repeats the id: `{ "error": "internal_error", "requestId": … }`.
- Access-log lines use `warn` for 4xx and `error` for 5xx.
- `Error` fields serialise as `{ name, message, stack, …own fields }`. With a trace active, the line
  also carries `traceId` and `spanId`.

### Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://otel-collector:4318`) and the API exports
spans over OTLP/HTTP with the OpenTelemetry SDK. Unset, the SDK is never loaded and every tracer
call is a no-op.

Each trace holds one server span per request (`GET /api/v1/health`, via `@hono/otel`); an
incoming `traceparent` is honoured. `OTEL_SERVICE_NAME` overrides `service.name`
(`starterdough-api`). `OTEL_EXPORTER_OTLP_HEADERS` carries auth for hosted backends. The probes
(`/healthz`, `/readyz`) are not traced. `url.full` on server spans carries no query string, so
verification tokens and OAuth codes stay out of the backend. SDK trouble such as a refused export
is logged as `component=otel` at `warn` or `error`.

To look at traces locally, run a collector that prints what it receives. The image's default
config listens on the container's own loopback only, so it needs a config file:

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
exception`) and exits 1. The supervisor restarts the process.

`SIGTERM` and `SIGINT` run this sequence:

1. Stop the listener.
2. Give in-flight requests 10 s, then force-close what is left.
3. Flush spans, 3 s at most.
4. Close the database pool (1 s) and exit 0.

The budgets add up to less than compose's `stop_grace_period` (15 s), so the pool closes before
the SIGKILL.

Each API process holds up to `DATABASE_POOL_MAX` connections (default 10). Postgres refuses
connections past `max_connections` (100 by default). Keep
`api replicas × pool + migrate + backup + headroom` below it. The pool survives `bun --hot`
reloads, so changing `DATABASE_URL` or `DATABASE_POOL_MAX` needs a restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_FORMAT` | `json` in production, `pretty` otherwise | Log line format |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | Lowest level written (`debug`/`info`/`warn`/`error`) |
| `TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For`. Set it only where Caddy or a load balancer fronts the API |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(unset: tracing off)* | OTLP/HTTP collector base URL |
| `DATABASE_POOL_MAX` | `10` | Postgres connections per process |
| `OTEL_SERVICE_NAME` | `starterdough-api` | `service.name` on spans |
