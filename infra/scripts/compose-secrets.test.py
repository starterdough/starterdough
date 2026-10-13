#!/usr/bin/env python3
"""Verify the off-site backup credentials and the heartbeat URL reach the backup service only.

`env_file: ../.env` hands a service the whole file, and every service built from apps/api names it
for its own settings; `x-api-env` in infra/compose.yml blanks these rows for them. CI's infra job
appends a sentinel value for each row to .env, then runs this with every profile enabled, so a
service added later that picks the values up fails here.
"""

import json
import os
import subprocess
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
SENTINEL = "ci-sentinel"
ROWS = ("BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_HEARTBEAT_URL")


def fail(message: str) -> None:
    raise SystemExit(f"backup credentials regression: {message}")


def compose(*arguments: str, profiles: str = "") -> str:
    # From the repository root, the way the runbook runs Compose: .env there sets COMPOSE_FILE and
    # is the file every env_file names.
    result = subprocess.run(
        ["docker", "compose", *arguments],
        cwd=REPOSITORY,
        env={**os.environ, "COMPOSE_PROFILES": profiles},
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"docker compose {' '.join(arguments)} failed:\n{result.stderr.strip()}")
    return result.stdout


def holders(node: object, path: str) -> list[str]:
    """Every value under node that holds the sentinel: environment, build args, command, labels."""
    if isinstance(node, dict):
        return [hit for key, value in node.items() for hit in holders(value, f"{path}.{key}")]
    if isinstance(node, list):
        return [hit for index, item in enumerate(node) for hit in holders(item, f"{path}[{index}]")]
    return [path] if SENTINEL in str(node) else []


def main() -> None:
    # Every profile the file defines, read from it rather than listed here, so the check covers a
    # profile added later and runs unchanged in an edition without the worker.
    profiles = compose("config", "--profiles").split()
    if "backup" not in profiles:
        fail(f"no backup profile among {profiles}")

    try:
        config = json.loads(compose("config", "--format", "json", profiles=",".join(profiles)))
        services = config["services"]
        backup = services["backup"].get("environment") or {}
    except (json.JSONDecodeError, KeyError, AttributeError, TypeError) as error:
        fail(f"Docker Compose returned an unexpected config: {error!r}")

    # Without this the check below passes on a .env that never got the sentinels.
    missing = [row for row in ROWS if SENTINEL not in str(backup.get(row) or "")]
    if missing:
        fail(f"the backup service does not receive {missing}; does .env hold the sentinel rows?")

    leaks = holders({key: value for key, value in config.items() if key != "services"}, "")
    for name, service in services.items():
        if name != "backup":
            leaks += holders(service, f".services.{name}")
    if leaks:
        fail(
            f"a backup credential reaches {', '.join(leaks)}: blank the row in x-api-env, or keep"
            " that service off env_file"
        )

    print(f"backup credentials: the backup service only (profiles {', '.join(profiles)})")


if __name__ == "__main__":
    main()
