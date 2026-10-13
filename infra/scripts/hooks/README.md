# Deploy hooks

`infra/scripts/deploy.sh` runs your own scripts at two points of every deploy, from CI or by hand:

| Directory | When | If one fails |
| --- | --- | --- |
| `pre-deploy.d/` | after the images are pulled, before the release backup and before any writer stops | the deploy stops; production keeps its current release |
| `post-deploy.d/` | after the new release is ready, its recovery journal is cleared and old images are pruned | `deploy.sh` exits 1 and the Deploy job fails, with the new release already live |

Recover deployment and the demo's `update.sh` run no hooks. Both directories ship empty. The kit
never adds a file to them, so a kit upgrade never conflicts with yours. Commit your hooks like any
other product file.

## The contract

- Every `*.sh` file in the directory runs with `bash`, one after another, in name order. Number
  them to fix the order: `10-check-disk.sh`, `20-notify.sh`. Other files are ignored.
- They run from the repository root, in the checkout being deployed, so they can read `.env` and
  call `docker compose`.
- `IMAGE_TAG` is the tag being deployed (`sha-abc1234`, or a version on a rollback) and
  `DEPLOY_REVISION` the full commit id checked out.
- Standard input is closed. Nothing can answer a prompt, and a command that reads stdin gets
  end-of-file instead of waiting.
- They run under the deploy's host lock: file descriptor 8 holds it and
  `STARTERDOUGH_OPERATION_LOCK_HELD=1` says so. Every other deploy, recovery or demo reset waits
  for the lock or is refused while a hook runs, so keep hooks short, and never start a deploy or a
  recovery from one.
- The first hook that exits non-zero stops the rest of its directory.

When the Deploy workflow also moves a public demo (`DEMO_PATH`), the demo has already been updated
when the pre-deploy hooks run; a failing hook stops production only.

## Examples

A pre-deploy check that refuses to deploy onto a nearly full disk:

```sh
# pre-deploy.d/10-disk.sh
free_kb="$(df --output=avail -k / | tail -n 1)"
[ "$free_kb" -gt 2000000 ] || { echo "less than 2 GB free on /" >&2; exit 1; }
```

A post-deploy notification, with the webhook URL in `.env`:

```sh
# post-deploy.d/50-notify.sh
url="$(grep -E '^DEPLOY_NOTIFY_URL=' .env | cut -d= -f2-)"
[ -z "$url" ] || curl -fsS -m 10 -d "deployed $IMAGE_TAG ($DEPLOY_REVISION)" "$url" >/dev/null
```
