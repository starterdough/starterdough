#!/usr/bin/env python3
"""Durable deployment-interruption journal operations.

The journal contains only identifiers and hashes. Compose configuration is read
solely to calculate a hash, so interpolated environment values are never logged.
"""

import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


STATE_DIR = Path(
    os.environ.get("STARTERDOUGH_STATE_DIR", str(Path.home() / ".local/state/starterdough"))
)
JOURNAL = STATE_DIR / "deployment-interrupted"
REVISION = re.compile(r"[0-9a-f]{40}\Z")
CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
PROJECT_SERVICES = {
    "starterdough": {
        "api",
    },
    "starterdough-demo": {"demo-api"},
}
LOCKED = False


def fail(message: str) -> None:
    raise ValueError(message)


def has_control(value: str) -> bool:
    return any(character in value for character in "\x00\r\n\t")


def run(*arguments: str, output: bool = True) -> str:
    result = subprocess.run(
        arguments,
        check=False,
        text=True,
        stdout=subprocess.PIPE if output else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        pass_fds=(8,) if LOCKED else (),
    )
    if result.returncode != 0:
        raise RuntimeError(f"{arguments[0]} {arguments[1]} failed")
    return result.stdout.strip() if output else ""


def require_operation_lock() -> None:
    global LOCKED
    try:
        descriptor = os.fstat(8)
        lock = os.stat(STATE_DIR / "operations.lock")
    except OSError as error:
        raise ValueError("valid operation lock is required") from error
    if (descriptor.st_dev, descriptor.st_ino) != (lock.st_dev, lock.st_ino):
        fail("valid operation lock is required")
    try:
        fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        raise ValueError("operation lock is held by another process") from error
    LOCKED = True


def git_revision() -> str:
    revision = run("git", "rev-parse", "HEAD")
    if not REVISION.fullmatch(revision):
        fail("invalid current revision")
    return revision


def clean_worktree() -> bool:
    return all(
        subprocess.run(
            ("git", *arguments),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(8,) if LOCKED else (),
        ).returncode
        == 0
        for arguments in (("diff", "--quiet"), ("diff", "--cached", "--quiet"))
    )


def compose_config_hash() -> str:
    # Keep the fully interpolated config in memory. Its canonical JSON catches env_file and
    # environment-only changes without writing any of their values to the journal or output.
    config = json.loads(run("docker", "compose", "config", "--format", "json"))
    images = sorted(
        image
        for image in run("docker", "compose", "config", "--images").splitlines()
        if image
    )
    image_ids = []
    for image in images:
        image_id = run("docker", "image", "inspect", "--format", "{{.Id}}", image)
        if not IMAGE_ID.fullmatch(image_id):
            fail("invalid candidate image identity")
        image_ids.append([image, image_id])
    payload = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    payload += b"\0" + json.dumps(image_ids, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def journal_exists() -> bool:
    return os.path.lexists(JOURNAL)


def fsync_directory() -> None:
    descriptor = os.open(STATE_DIR, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save(value: dict[str, object]) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".deployment-interrupted.", dir=STATE_DIR)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, JOURNAL)
        fsync_directory()
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def clear() -> None:
    if JOURNAL.is_symlink() or not JOURNAL.is_file():
        fail("journal is not a regular file")
    JOURNAL.unlink()
    fsync_directory()


def require_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or has_control(value):
        fail(f"invalid {field}")
    return value


def load() -> dict[str, object]:
    if JOURNAL.is_symlink() or not JOURNAL.is_file():
        fail("journal is not a regular file")
    try:
        value = json.loads(JOURNAL.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("invalid journal") from error
    required = {"version", "phase", "project", "revision", "configHash", "checkout", "writers"}
    if not isinstance(value, dict) or set(value) != required or value["version"] != 1:
        fail("invalid journal schema")
    project = value["project"]
    phase = value["phase"]
    if (
        not isinstance(project, str)
        or project not in PROJECT_SERVICES
        or not isinstance(phase, str)
        or phase not in {"pre-replacement", "forward-only"}
    ):
        fail("invalid journal target")
    revision = value["revision"]
    config_hash = value["configHash"]
    checkout = value["checkout"]
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        fail("invalid journal revision")
    if not isinstance(config_hash, str) or not HASH.fullmatch(config_hash):
        fail("invalid journal configuration hash")
    if not isinstance(checkout, str) or not checkout.startswith("/") or has_control(checkout):
        fail("invalid journal checkout")
    writers = value["writers"]
    if not isinstance(writers, list):
        fail("invalid journal writers")
    seen_ids: set[str] = set()
    for writer in writers:
        if not isinstance(writer, dict) or set(writer) != {"id", "service", "image", "imageId"}:
            fail("invalid journal writer")
        container_id = require_string(writer["id"], "writer id")
        service = require_string(writer["service"], "writer service")
        require_string(writer["image"], "writer image")
        image_id = require_string(writer["imageId"], "writer image identity")
        if (
            not CONTAINER_ID.fullmatch(container_id)
            or service not in PROJECT_SERVICES[project]
            or not IMAGE_ID.fullmatch(image_id)
            or container_id in seen_ids
        ):
            fail("invalid journal writer identity")
        seen_ids.add(container_id)
    return value


def inspect_container(container_id: str) -> dict[str, object]:
    result = json.loads(run("docker", "inspect", container_id))
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        fail("invalid docker inspect response")
    return result[0]


def validate_old_writers(journal: dict[str, object]) -> list[dict[str, object]]:
    project = journal["project"]
    if not isinstance(project, str):
        fail("invalid journal project")
    writers = journal["writers"]
    if not isinstance(writers, list):
        fail("invalid journal writers")
    validated: list[dict[str, object]] = []
    for writer in writers:
        if not isinstance(writer, dict):
            fail("invalid journal writer")
        container_id = writer["id"]
        if not isinstance(container_id, str):
            fail("invalid journal writer id")
        inspected = inspect_container(container_id)
        config = inspected.get("Config")
        if not isinstance(config, dict):
            fail("container config missing")
        labels = config.get("Labels") or {}
        if not isinstance(labels, dict):
            fail("container labels invalid")
        if (
            inspected.get("Id") != container_id
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != writer["service"]
            or config.get("Image") != writer["image"]
            or inspected.get("Image") != writer["imageId"]
        ):
            fail("old writer identity changed")
        state = inspected.get("State")
        if not isinstance(state, dict) or not isinstance(state.get("Running"), bool):
            fail("container state invalid")
        validated.append({"id": container_id, "running": state["Running"]})
    return validated


def validate_target(journal: dict[str, object]) -> None:
    checkout = journal["checkout"]
    revision = journal["revision"]
    config_hash = journal["configHash"]
    if (
        os.getcwd() != checkout
        or not clean_worktree()
        or git_revision() != revision
        or compose_config_hash() != config_hash
    ):
        fail("recovery target does not match journal")


def ready(service: str) -> None:
    run(
        "docker", "compose", "exec", "-T", service, "bun", "-e",
        'fetch("http://127.0.0.1:3000/readyz").then((response) => process.exit(response.ok ? 0 : 1))',
        output=False,
    )


def ready_container(container_id: str) -> None:
    program = (
        'fetch("http://127.0.0.1:3000/readyz", { signal: AbortSignal.timeout(5000) })'
        '.then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
    )
    for attempt in range(30):
        try:
            run("docker", "exec", container_id, "bun", "-e", program, output=False)
            return
        except RuntimeError:
            inspected = inspect_container(container_id)
            state = inspected.get("State")
            if not isinstance(state, dict) or state.get("Running") is not True:
                fail("restored API writer is not running")
            if attempt == 29:
                fail("restored API writer did not become ready")
            time.sleep(2)


def expected_image_id(service: str) -> str:
    config = json.loads(run("docker", "compose", "config", "--format", "json"))
    services = config.get("services") if isinstance(config, dict) else None
    definition = services.get(service) if isinstance(services, dict) else None
    image = definition.get("image") if isinstance(definition, dict) else None
    if not isinstance(image, str) or not image or has_control(image):
        fail("candidate service image is invalid")
    image_id = run("docker", "image", "inspect", "--format", "{{.Id}}", image)
    if not IMAGE_ID.fullmatch(image_id):
        fail("candidate service image identity is invalid")
    return image_id


def validate_candidate_container(service: str, required: bool) -> None:
    container_ids = run("docker", "compose", "ps", "--quiet", service).splitlines()
    if not container_ids:
        if required:
            fail("candidate service container is missing")
        return
    if len(set(container_ids)) != len(container_ids):
        fail("candidate service container inventory is invalid")
    project = "starterdough-demo" if service == "demo-api" else "starterdough"
    expected = expected_image_id(service)
    for container_id in container_ids:
        inspected = inspect_container(container_id)
        config = inspected.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        state = inspected.get("State")
        if (
            not isinstance(labels, dict)
            or not isinstance(state, dict)
            or state.get("Running") is not True
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service
            or inspected.get("Image") != expected
        ):
            fail("candidate service image does not match resolved target")


def validate_candidate_writers(journal: dict[str, object]) -> None:
    project = journal["project"]
    if project == "starterdough":
        validate_candidate_container("api", required=True)
    elif project == "starterdough-demo":
        validate_candidate_container("demo-api", required=True)
    else:
        fail("invalid journal project")


def old_api_container(journal: dict[str, object]) -> str:
    service = "api" if journal["project"] == "starterdough" else "demo-api"
    writers = journal["writers"]
    if not isinstance(writers, list):
        fail("invalid journal writers")
    for writer in writers:
        if isinstance(writer, dict) and writer.get("service") == service:
            container_id = writer.get("id")
            if isinstance(container_id, str):
                return container_id
    fail("no recorded API writer to restore")


def begin(arguments: list[str]) -> None:
    if len(arguments) < 2:
        fail("begin requires project and services")
    project, requested = arguments[0], set(arguments[1:])
    if project not in PROJECT_SERVICES or not requested or not requested <= PROJECT_SERVICES[project]:
        fail("invalid deployment writers")
    if journal_exists():
        fail("deployment journal already exists")
    if not clean_worktree():
        fail("deployment checkout has tracked changes")
    config = json.loads(run("docker", "compose", "config", "--format", "json"))
    primary_service = "api" if project == "starterdough" else "demo-api"
    services = config.get("services") if isinstance(config, dict) else None
    if (
        not isinstance(config, dict)
        or config.get("name") != project
        or not isinstance(services, dict)
        or primary_service not in services
    ):
        fail("compose target does not match deployment")
    writers: list[dict[str, str]] = []
    for container_id in filter(None, run("docker", "compose", "ps", "--status", "running", "--quiet").splitlines()):
        inspected = inspect_container(container_id)
        config = inspected.get("Config")
        labels = config.get("Labels") if isinstance(config, dict) else None
        if not isinstance(labels, dict) or labels.get("com.docker.compose.project") != project:
            continue
        service = labels.get("com.docker.compose.service")
        if not isinstance(service, str) or service not in requested:
            continue
        old_id = inspected.get("Id")
        image = config.get("Image")
        image_id = inspected.get("Image")
        if (
            not isinstance(old_id, str)
            or not CONTAINER_ID.fullmatch(old_id)
            or not isinstance(image, str)
            or not image
            or has_control(image)
            or not isinstance(image_id, str)
            or not IMAGE_ID.fullmatch(image_id)
        ):
            fail("invalid running writer identity")
        writers.append({"id": old_id, "service": service, "image": image, "imageId": image_id})
    if writers and not any(writer["service"] == primary_service for writer in writers):
        fail("running writers do not include the primary API")
    save({
        "version": 1,
        # With no writer to revive, a power loss after this point must resume the prepared target.
        # Mark that forward-only before the caller reaches Compose rather than creating an
        # irrecoverable pre-replacement journal with no old API to probe.
        "phase": "pre-replacement" if writers else "forward-only",
        "project": project,
        "revision": git_revision(),
        "configHash": compose_config_hash(),
        "checkout": os.getcwd(),
        "writers": writers,
    })


def stop(journal: dict[str, object]) -> None:
    writers = journal["writers"]
    if journal["phase"] == "forward-only" and writers == []:
        return
    if journal["phase"] != "pre-replacement":
        fail("cannot stop writers after forward transition")
    writers = validate_old_writers(journal)
    for writer in writers:
        run("docker", "stop", "--time", "120", writer["id"], output=False)


def restore_pre(journal: dict[str, object]) -> None:
    if journal["phase"] != "pre-replacement":
        fail("old writers are unsafe after forward transition")
    writers = validate_old_writers(journal)
    for writer in writers:
        if not writer["running"]:
            run("docker", "start", writer["id"], output=False)


def forward(journal: dict[str, object]) -> None:
    writers = journal["writers"]
    if journal["phase"] == "forward-only" and writers == []:
        return
    if journal["phase"] != "pre-replacement":
        fail("invalid forward transition")
    validate_target(journal)
    writers = validate_old_writers(journal)
    if any(writer["running"] for writer in writers):
        fail("writers are still running")
    journal["phase"] = "forward-only"
    save(journal)


def complete(journal: dict[str, object], service: str) -> None:
    if journal["phase"] != "forward-only":
        fail("cannot complete pre-replacement deployment")
    project = journal["project"]
    primary_service = "api" if project == "starterdough" else "demo-api"
    if not isinstance(project, str) or service != primary_service:
        fail("invalid readiness service")
    validate_target(journal)
    validate_candidate_writers(journal)
    ready(service)
    clear()


def recover(journal: dict[str, object]) -> None:
    validate_target(journal)
    project = journal["project"]
    if not isinstance(project, str):
        fail("invalid journal project")
    service = "api" if project == "starterdough" else "demo-api"
    if journal["phase"] == "pre-replacement":
        restore_pre(journal)
        if any(not writer["running"] for writer in validate_old_writers(journal)):
            fail("restored writer is not running")
        ready_container(old_api_container(journal))
    else:
        timeout = "180" if project == "starterdough" else "300"
        run(
            "docker", "compose", "up", "-d", "--remove-orphans", "--wait", "--wait-timeout", timeout,
            "--no-build", "--pull", "never", output=False,
        )
        validate_candidate_writers(journal)
    ready(service)
    clear()
    print("deployment_recovery_complete")


def main(arguments: list[str]) -> None:
    if not arguments:
        fail("missing operation")
    operation = arguments[0]
    if operation == "status":
        if not journal_exists():
            print("deployment_recovery_pending=false")
            return
        journal = load()
        print("deployment_recovery_pending=true")
        print(f"deployment_recovery_phase={journal['phase']}")
        print(f"deployment_recovery_revision={journal['revision']}")
        print(f"deployment_recovery_checkout={journal['checkout']}")
        return
    require_operation_lock()
    if operation == "begin":
        begin(arguments[1:])
        return
    journal = load()
    if operation == "stop":
        stop(journal)
    elif operation == "forward":
        forward(journal)
    elif operation == "complete" and len(arguments) == 2:
        complete(journal, arguments[1])
    elif operation == "recover":
        recover(journal)
    else:
        fail("unknown operation")


try:
    main(sys.argv[1:])
except (OSError, RuntimeError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
    print(f"deployment recovery: {error}", file=sys.stderr)
    raise SystemExit(1)
