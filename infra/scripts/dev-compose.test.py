#!/usr/bin/env python3
"""Verify the development database scripts resolve the intended Compose project and port."""

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]
EXPECTED_PROJECT = "starterdough-dev"
EXPECTED_PORT = "55432"


def fail(message: str) -> None:
    raise SystemExit(f"development Compose regression: {message}")


def compose_prefix() -> list[str]:
    package = json.loads((REPOSITORY / "package.json").read_text(encoding="utf-8"))
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        fail("package.json has no scripts object")

    commands: dict[str, list[str]] = {}
    for name in ("db:up", "db:down"):
        command = scripts.get(name)
        if not isinstance(command, str):
            fail(f"package.json has no {name} script")
        try:
            commands[name] = shlex.split(command)
        except ValueError as error:
            fail(f"cannot parse {name}: {error}")

    up = commands["db:up"]
    down = commands["db:down"]
    if up[-2:] != ["up", "-d"]:
        fail("db:up must end with 'up -d'")
    if down[-1:] != ["down"]:
        fail("db:down must end with 'down'")

    prefix = up[:-2]
    if prefix != down[:-1]:
        fail("db:up and db:down must use the same Compose options")
    if prefix[:2] != ["docker", "compose"]:
        fail("database scripts must invoke Docker Compose")
    return prefix


def main() -> None:
    prefix = compose_prefix()
    with tempfile.TemporaryDirectory(prefix="starterdough-dev-compose-") as temporary:
        fixture = Path(temporary)
        (fixture / "infra").mkdir()
        shutil.copy2(REPOSITORY / "infra/compose.dev.yml", fixture / "infra/compose.dev.yml")
        (fixture / ".env").write_text(
            f"COMPOSE_PROJECT_NAME=starterdough\nPOSTGRES_PORT={EXPECTED_PORT}\n",
            encoding="utf-8",
        )

        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("COMPOSE_") and key != "POSTGRES_PORT"
        }
        result = subprocess.run(
            [*prefix, "config", "--format", "json"],
            cwd=fixture,
            env=environment,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            fail(f"Docker Compose rejected the db script options:\n{result.stderr.strip()}")

        try:
            config = json.loads(result.stdout)
            ports = config["services"]["postgres"]["ports"]
            published = next(
                str(port["published"]) for port in ports if str(port["target"]) == "5432"
            )
        except (json.JSONDecodeError, KeyError, StopIteration, TypeError) as error:
            fail(f"Docker Compose returned an unexpected config: {error}")

        if config.get("name") != EXPECTED_PROJECT:
            fail(f"resolved project {config.get('name')!r}, expected {EXPECTED_PROJECT!r}")
        if published != EXPECTED_PORT:
            fail(f"published Postgres on {published!r}, expected {EXPECTED_PORT!r}")

    print(f"development Compose: project={EXPECTED_PROJECT} postgres_port={EXPECTED_PORT}")


if __name__ == "__main__":
    main()
