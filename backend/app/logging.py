"""One logging configuration for the whole app: structured, correlated.

Every log line carries the request id (and user id once auth resolved),
injected via contextvars so no call site has to thread them through. The
format is JSON lines on stdout -- the container-native shape collectors
ingest -- in production, and a compact human line in development. Nothing
here ever logs data values; that rule is enforced by tests, not habit
(see tests/test_logging.py).
"""

import json
import logging
import sys
import time
from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)


def set_user(user_id: object) -> None:
    """Attach the authenticated user to every subsequent log line of this
    request. Called from the auth resolvers -- the funnels -- only."""
    user_id_var.set(str(user_id))


class ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        record.user_id = user_id_var.get()
        return True


#: LogRecord attributes that are plumbing, not payload. Anything a caller
#: passes via `extra=` lands outside this set and is serialised.
_STANDARD = frozenset(vars(logging.makeLogRecord({})) ) | {"request_id", "user_id"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.request_id:
            out["request_id"] = record.request_id
        if record.user_id:
            out["user_id"] = record.user_id
        for key, value in vars(record).items():
            if key not in _STANDARD and not key.startswith("_"):
                out[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


class PlainFormatter(logging.Formatter):
    """Development: readable, still carrying the correlation id."""

    def format(self, record: logging.LogRecord) -> str:
        rid = f" [{record.request_id[:8]}]" if record.request_id else ""
        base = f"{record.levelname:<7}{rid} {record.name}: {record.getMessage()}"
        extras = {
            key: value
            for key, value in vars(record).items()
            if key not in _STANDARD and not key.startswith("_")
        }
        if extras:
            base += " " + " ".join(f"{k}={v}" for k, v in extras.items())
        if record.exc_info and record.exc_info[0] is not None:
            base += "\n" + self.formatException(record.exc_info)
        return base


def setup_logging(fmt: str) -> None:
    """Route EVERYTHING through one stdout handler. Idempotent, so tests
    and reloads do not stack handlers."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if fmt == "json" else PlainFormatter())
    handler.addFilter(ContextFilter())
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # Uvicorn ships its own handlers; fold them into ours so one
    # collector sees one stream.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    # ...except the access log, which writes the path WITH its query
    # string -- search terms, feed filter values, and a live OAuth
    # authorization code on every sign-in. Uvicorn emits it only when
    # the logger has a handler, so leaving it detached silences it.
    # The app's own request line (app/main.py) already records method,
    # path and status, carries the request id, and logs no query string.
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False


class RequestTimer:
    """Context data for the per-request summary line."""

    def __init__(self) -> None:
        self.started = time.perf_counter()

    @property
    def duration_ms(self) -> int:
        return int((time.perf_counter() - self.started) * 1000)
