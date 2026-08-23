#!/usr/bin/env python3
"""One command to set this project up, run it, or check what is wrong with it.

    python dev.py setup     install everything a fresh clone needs
    python dev.py run       start the backend and the frontend together
    python dev.py test      the whole suite: backend, frontend, types
    python dev.py doctor    what is installed, what is running, what is stale

WHY A PYTHON SCRIPT. The backend needs Python anyway, so it is the one tool
guaranteed to be on the machine before anything is installed -- a shell script
would need a Windows twin and they would drift. Nothing here imports anything
outside the standard library, because it has to run BEFORE the virtualenv it
creates exists.

WHY `run` EXISTS AT ALL. Two servers, and the frontend's proxy target is read
once when Vite starts, so a backend on a different port means restarting the
frontend too. On top of that, killing uvicorn on Windows can leave the socket
LISTENING against a dead PID, and rebinding then fails AFTER the log has
already said "Application startup complete". `run` picks a port that is
actually free, tells Vite about it, and shuts both down together.

Everything here is idempotent. Running `setup` twice is not an error, and it
will not overwrite a .env you have edited.
"""

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"

MIN_PYTHON = (3, 12)
#: Vite 8's own floor. Either of these majors is fine.
MIN_NODE = "20.19 (or 22.12+)"

WINDOWS = platform.system() == "Windows"
NPM = "npm.cmd" if WINDOWS else "npm"


# --- small helpers ----------------------------------------------------------


class Failed(Exception):
    """A step that could not continue. The message is for a human."""


def say(message: str) -> None:
    print(f"  {message}", flush=True)


def step(message: str) -> None:
    print(f"\n=> {message}", flush=True)


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if WINDOWS else "bin/python")


def run(command: list[str], *, cwd: Path, env: dict | None = None) -> None:
    """Run a command, letting its output through. Raises on failure."""
    result = subprocess.run(command, cwd=str(cwd), env=env)
    if result.returncode != 0:
        raise Failed(f"`{' '.join(command)}` failed (exit {result.returncode})")


def capture(command: list[str]) -> str | None:
    """Stdout of a command, or None if it is not installed or fails."""
    try:
        out = subprocess.run(
            command, capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return (out.stdout or out.stderr).strip() if out.returncode == 0 else None


def free_port(preferred: int) -> int:
    """`preferred` if it can actually be bound, else a port the OS picks.

    Bound rather than merely probed, because a socket orphaned by a killed
    process still answers "in use" -- which is the case this exists for.
    """
    for port in (preferred, 0):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return probe.getsockname()[1]
            except OSError:
                continue
    raise Failed("could not find a free port")


# --- setup ------------------------------------------------------------------


def check_prerequisites() -> None:
    step("Checking prerequisites")
    if sys.version_info < MIN_PYTHON:
        wanted = ".".join(map(str, MIN_PYTHON))
        hint = (
            f"py -{wanted} dev.py setup" if WINDOWS else f"python{wanted} dev.py setup"
        )
        # Naming the command matters: a machine with several Pythons usually
        # has a new enough one, just not the one `python` resolves to.
        raise Failed(
            f"Python {wanted}+ required; `python` here is "
            f"{platform.python_version()}."
            f"\n  If you have a newer one installed, run:  {hint}"
        )
    say(f"Python {platform.python_version()}")

    node = capture(["node", "--version"])
    if not node:
        raise Failed(f"Node is not installed or not on PATH. Need {MIN_NODE}.")
    say(f"Node {node}")

    if not capture([NPM, "--version"]):
        raise Failed("npm is not on PATH, though Node is. Check your Node install.")

    if not shutil.which("docker"):
        say("Docker not found - skipping Postgres. Set SEMANTICUI_DATABASE_URL")
        say("in backend/.env to point at a Postgres you already run.")


def start_postgres() -> None:
    if not shutil.which("docker"):
        return
    step("Starting Postgres")
    try:
        run(["docker", "compose", "up", "-d", "postgres"], cwd=ROOT)
    except Failed as exc:
        # Not fatal: plenty of people run their own Postgres, and the failure
        # here is usually "Docker Desktop is not running", which is theirs to
        # fix rather than ours to guess at.
        say(f"could not start Postgres ({exc})")
        say("carrying on - set SEMANTICUI_DATABASE_URL if you have your own")
        return
    say("postgres up on localhost:5432 (semanticui/semanticui/semanticui)")


def setup_backend() -> None:
    step("Backend")
    if venv_python().exists():
        say(f"virtualenv already at {VENV.relative_to(ROOT)}")
    else:
        say("creating virtualenv")
        run([sys.executable, "-m", "venv", str(VENV)], cwd=BACKEND)

    say("installing dependencies (this is the slow part)")
    run([str(venv_python()), "-m", "pip", "install", "-q", "-e", ".[dev]"], cwd=BACKEND)

    env_file = BACKEND / ".env"
    if env_file.exists():
        # Never clobbered: it holds credentials by the time anyone runs this
        # a second time.
        say(".env already exists - left alone")
    else:
        shutil.copyfile(BACKEND / ".env.example", env_file)
        say("copied .env.example -> .env")

    say("applying migrations")
    run([str(venv_python()), "-m", "alembic", "upgrade", "head"], cwd=BACKEND)


def setup_frontend() -> None:
    step("Frontend")
    if (FRONTEND / "node_modules").exists():
        say("node_modules present - running npm install to top it up")
    run([NPM, "install", "--no-fund", "--no-audit"], cwd=FRONTEND)


def do_setup() -> None:
    check_prerequisites()
    start_postgres()
    setup_backend()
    setup_frontend()
    print(
        "\nDone. Start it with:\n"
        "\n    python dev.py run\n"
        "\nThen open http://localhost:5173 and sign in with your own Snowflake\n"
        "account. You need at least one semantic view your role can see.\n"
    )


# --- run --------------------------------------------------------------------


def pipe(prefix: str, stream, lock: threading.Lock) -> None:
    """Tag each line with which server it came from.

    Two servers writing to one terminal is otherwise unreadable, and the whole
    point of this command is that you only watch one terminal.

    The write is guarded because Vite prints U+279C and a Windows console is
    cp1252 by default: an unguarded print raises UnicodeEncodeError, kills
    this thread, and the frontend silently stops being logged while it is
    still perfectly alive. `main` also reconfigures stdout to UTF-8; this is
    the belt to that braces, since a console that still cannot render a glyph
    must not cost us the log.
    """
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        with lock:
            try:
                print(f"{prefix} {line}", flush=True)
            except UnicodeEncodeError:
                encoding = sys.stdout.encoding or "ascii"
                safe = line.encode(encoding, "replace").decode(encoding, "replace")
                print(f"{prefix} {safe}", flush=True)


def do_run(backend_port: int, frontend_port: int) -> None:
    if not venv_python().exists():
        raise Failed("no virtualenv - run `python dev.py setup` first")
    if not (FRONTEND / "node_modules").exists():
        raise Failed("no node_modules - run `python dev.py setup` first")

    port = free_port(backend_port)
    if port != backend_port:
        say(f"port {backend_port} is taken, using {port} instead")

    web_port = free_port(frontend_port)
    if web_port != frontend_port:
        say(f"port {frontend_port} is taken, using {web_port} instead")

    api = f"http://localhost:{port}"
    step(f"Backend on {api}")
    backend = subprocess.Popen(
        [
            str(venv_python()), "-m", "uvicorn", "app.main:app",
            "--port", str(port), "--host", "127.0.0.1", "--reload",
            # Watch the application only. Uvicorn's default is the whole
            # working directory, so writing a test, running the suite, or
            # touching the SQLite file restarts the server mid-request --
            # which reads as the app crashing.
            "--reload-dir", "app",
        ],
        cwd=str(BACKEND),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # The proxy target is read once, at startup -- which is exactly why the
    # backend's port has to be settled before this line and not after.
    step(f"Frontend on http://localhost:{web_port}, proxying to {api}")
    frontend = subprocess.Popen(
        [NPM, "run", "dev", "--", "--port", str(web_port), "--strictPort"],
        cwd=str(FRONTEND),
        env={**os.environ, "SEMANTICUI_API_TARGET": api},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    lock = threading.Lock()
    for name, process in (("[api]", backend), ("[web]", frontend)):
        threading.Thread(
            target=pipe, args=(name, process.stdout, lock), daemon=True
        ).start()

    print(
        f"\n    Open http://localhost:{frontend_port}\n"
        "    Ctrl-C stops both.\n",
        flush=True,
    )
    try:
        while True:
            for name, process in (("backend", backend), ("frontend", frontend)):
                if process.poll() is not None:
                    raise Failed(f"the {name} exited ({process.returncode})")
            time.sleep(0.4)
    except KeyboardInterrupt:
        print("\nstopping…", flush=True)
    finally:
        # Frontend first: it is the one holding the browser connection, and
        # `terminate()` is the portable one -- on Windows it is
        # TerminateProcess, elsewhere SIGTERM. Killing follows if a server
        # ignores it, because leaving uvicorn alive is how the next run finds
        # its port taken.
        for process in (frontend, backend):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()


# --- test and doctor --------------------------------------------------------


def do_test() -> None:
    step("Backend tests")
    run([str(venv_python()), "-m", "pytest", "-q"], cwd=BACKEND)
    step("Frontend tests")
    run([NPM, "test"], cwd=FRONTEND)
    step("Types")
    run([NPM, "run", "typecheck"], cwd=FRONTEND)
    print("\nAll green.\n")


def port_holder(port: int) -> str:
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
            return "free"
        except OSError:
            return "in use"


def do_doctor() -> None:
    step("Tools")
    say(f"python     {platform.python_version()}  ({sys.executable})")
    say(f"node       {capture(['node', '--version']) or 'NOT FOUND'}")
    say(f"npm        {capture([NPM, '--version']) or 'NOT FOUND'}")
    say(f"docker     {capture(['docker', '--version']) or 'not installed'}")

    step("This clone")
    say(f"virtualenv {'yes' if venv_python().exists() else 'MISSING - run setup'}")
    say(f".env       {'yes' if (BACKEND / '.env').exists() else 'MISSING - run setup'}")
    say(
        f"node_modules "
        f"{'yes' if (FRONTEND / 'node_modules').exists() else 'MISSING - run setup'}"
    )

    step("Ports")
    for port, what in ((5432, "postgres"), (8000, "backend"), (5173, "frontend")):
        say(f"{port:<6} {what:<9} {port_holder(port)}")
    say("")
    say("A port 'in use' with nothing running is the orphaned-socket case:")
    say("`python dev.py run` will step around it by picking another.")


# --- entry point ------------------------------------------------------------


def main() -> int:
    # Both servers emit UTF-8; a Windows console defaults to cp1252.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(
        prog="dev.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup", help="install everything a fresh clone needs")
    runner = sub.add_parser("run", help="start the backend and the frontend")
    runner.add_argument("--backend-port", type=int, default=8000)
    runner.add_argument("--frontend-port", type=int, default=5173)
    sub.add_parser("test", help="backend tests, frontend tests, typecheck")
    sub.add_parser("doctor", help="what is installed, what is running")
    args = parser.parse_args()

    try:
        if args.command == "setup":
            do_setup()
        elif args.command == "run":
            do_run(args.backend_port, args.frontend_port)
        elif args.command == "test":
            do_test()
        elif args.command == "doctor":
            do_doctor()
    except Failed as exc:
        print(f"\nStopped: {exc}\n", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
