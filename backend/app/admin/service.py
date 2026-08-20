"""What the admin area reads: health, the activity log, and alerts.

Everything here is derived from things the app already records -- the
audit trail, the app database, the process itself. Nothing new is
collected to make these pages work, which is the point: a monitoring
surface that needs its own instrumentation is a second source of truth
about what happened.

The audit trail's own contract carries through unchanged. `detail` holds
shapes -- counts, flags, durations -- never data values, resource names
or tokens, so a page that renders the log verbatim still cannot leak the
contents of anybody's report.
"""

import os
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.db.models import AuditEvent, Dashboard, Report, SavedExplore, User, Workspace

#: When this process started, for uptime. Module import is close enough to
#: process start to be honest, and does not need a hook in the app factory.
STARTED_AT = time.time()

#: The window the security board and the activity summary look back over.
DEFAULT_WINDOW_HOURS = 24

#: The action a failed sign-in is recorded under. Named once, here,
#: because the security board matched "auth.failed" -- a name nothing ever
#: wrote -- and so reported a quiet window through any number of failures.
FAILED_LOGIN = "auth.login_failed"
#: And the one a refused-for-rate attempt is recorded under.
RATE_LIMITED = "auth.rate_limited"

#: Actions that mean somebody was refused. Counted from this set rather
#: than pattern-matched at read time, so adding an action means adding it
#: here on purpose -- and so that a name that no longer exists shows up as
#: a test failure rather than as an empty board.
DENIAL_ACTIONS = frozenset(
    {
        FAILED_LOGIN,
        RATE_LIMITED,
        # Every workspace-governed refusal funnels through the single
        # authorization gate and lands here, whatever was being reached
        # for -- which is why there is no per-resource denial action to
        # list beside it.
        "access.denied",
        "admin.denied",
    }
)

#: Outcomes that are not "it worked".
BAD_OUTCOMES = frozenset({"denied", "error", "failed"})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def health(db: Session) -> dict:
    """Is each moving part answering, and how quickly.

    The database check is a real round trip rather than a connection-pool
    reading: a pool can hold a handle to a server that has stopped
    answering, which is exactly the failure this page exists to catch.
    """
    checks: list[dict] = []

    started = time.perf_counter()
    try:
        db.execute(text("SELECT 1"))
        checks.append(
            {
                "name": "Application database",
                "status": "ok",
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                "detail": _database_kind(db),
            }
        )
    except Exception as error:  # noqa: BLE001 -- the message IS the answer
        checks.append(
            {
                "name": "Application database",
                "status": "down",
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                # The class, not the message: a driver error can carry a
                # connection string, and this page is read in a browser.
                "detail": type(error).__name__,
            }
        )

    # The API is answering by definition -- this response is the proof --
    # so it is reported as a fact rather than measured.
    checks.append(
        {
            "name": "API",
            "status": "ok",
            "latencyMs": None,
            "detail": f"pid {os.getpid()}",
        }
    )

    return {
        "status": "down" if any(c["status"] == "down" for c in checks) else "ok",
        "uptimeSeconds": round(time.time() - STARTED_AT),
        "checks": checks,
        "counts": _counts(db),
    }


def _database_kind(db: Session) -> str:
    """"PostgreSQL 16.2" or "SQLite" -- the thing an operator wants to
    confirm before anything else."""
    try:
        name = db.bind.dialect.name if db.bind else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"
    if name == "postgresql":
        try:
            version = db.execute(text("SHOW server_version")).scalar()
            return f"PostgreSQL {version}"
        except Exception:  # noqa: BLE001
            return "PostgreSQL"
    return name.capitalize()


def _counts(db: Session) -> dict:
    """What the install holds. Cheap, and the first question anybody asks
    of a deployment they have just been handed."""
    def total(model) -> int:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)

    return {
        "users": total(User),
        "workspaces": total(Workspace),
        "reports": total(Report),
        "dashboards": total(Dashboard),
        "explores": total(SavedExplore),
    }


def _names(db: Session, user_ids) -> dict:
    keys = {uid for uid in user_ids if uid is not None}
    if not keys:
        return {}
    rows = db.execute(
        select(User.id, User.snowflake_user).where(User.id.in_(keys))
    ).all()
    return {uid: name for uid, name in rows}


def events(
    db: Session,
    *,
    action: str | None = None,
    outcome: str | None = None,
    user: str | None = None,
    hours: int | None = None,
    limit: int = 100,
    before: str | None = None,
) -> dict:
    """A page of the audit trail, newest first.

    Keyset paging on `ts` rather than an offset: the trail grows while it
    is being read, and an offset would skip or repeat rows as it did.
    """
    query = select(AuditEvent).order_by(AuditEvent.ts.desc(), AuditEvent.id.desc())
    if action:
        query = query.where(AuditEvent.action == action)
    if outcome:
        query = query.where(AuditEvent.outcome == outcome)
    if hours:
        query = query.where(AuditEvent.ts >= _now() - timedelta(hours=hours))
    if user:
        # Resolved to ids first: the trail stores who by id, and matching
        # the name at read time is what keeps it that way.
        ids = [
            row[0]
            for row in db.execute(
                select(User.id).where(func.upper(User.snowflake_user) == user.upper())
            ).all()
        ]
        # An unknown name matches nothing rather than everything.
        query = query.where(AuditEvent.user_id.in_(ids or [None]))
    if before:
        cursor = _parse_ts(before)
        if cursor is not None:
            query = query.where(AuditEvent.ts < cursor)

    capped = max(1, min(limit, 500))
    # One extra, to know whether there is another page without counting
    # the whole table.
    rows = list(db.scalars(query.limit(capped + 1)))
    more = len(rows) > capped
    rows = rows[:capped]

    names = _names(db, [row.user_id for row in rows])
    return {
        "events": [
            {
                "id": str(row.id),
                "ts": row.ts.isoformat(),
                "action": row.action,
                "outcome": row.outcome,
                "user": names.get(row.user_id, ""),
                "requestId": row.request_id,
                "sessionRef": row.session_ref,
                "resourceType": row.resource_type,
                "resourceId": row.resource_id,
                "detail": row.detail,
            }
            for row in rows
        ],
        # The cursor for the next page, or null when this was the last.
        "nextBefore": rows[-1].ts.isoformat() if more and rows else None,
        "actions": _known_actions(db),
    }


def _parse_ts(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _known_actions(db: Session) -> list[str]:
    """Every action the trail actually contains, so the filter offers what
    is there rather than a list written months ago."""
    return sorted(
        row[0] for row in db.execute(select(AuditEvent.action).distinct()).all() if row[0]
    )


def security(db: Session, hours: int = DEFAULT_WINDOW_HOURS) -> dict:
    """What an operator should look at, derived from the same trail.

    Alerts, not raw counts: "seventeen sign-in failures" is a number, and
    "seventeen sign-in failures from four sessions" is the thing worth
    waking up for. Each alert says what it counted and over what window,
    because an alert you cannot check is an alert you learn to ignore.
    """
    since = _now() - timedelta(hours=hours)
    rows = list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.ts >= since)
            .order_by(AuditEvent.ts.desc())
        )
    )

    failures = [r for r in rows if r.action == FAILED_LOGIN]
    throttled = [r for r in rows if r.action == RATE_LIMITED]
    denials = [
        r for r in rows if r.action in DENIAL_ACTIONS or r.outcome in BAD_OUTCOMES
    ]
    names = _names(db, [r.user_id for r in denials])

    alerts: list[dict] = []
    if failures:
        sessions = len({r.session_ref for r in failures if r.session_ref})
        alerts.append(
            {
                "id": "auth-failures",
                "severity": "high" if len(failures) >= 10 else "info",
                "title": "Failed sign-ins",
                "count": len(failures),
                "detail": (
                    f"{len(failures)} in the last {hours}h"
                    + (f", from {sessions} session(s)" if sessions else "")
                ),
            }
        )
    if throttled:
        alerts.append(
            {
                "id": "rate-limited",
                "severity": "high",
                "title": "Sign-in throttling engaged",
                "count": len(throttled),
                "detail": (
                    f"{len(throttled)} attempt(s) refused for rate in the last {hours}h"
                ),
            }
        )

    refusals = [r for r in denials if r.action != FAILED_LOGIN]
    if refusals:
        by_user = Counter(names.get(r.user_id, "") or "unknown" for r in refusals)
        worst, worst_count = by_user.most_common(1)[0]
        alerts.append(
            {
                "id": "access-denied",
                "severity": "medium" if worst_count >= 5 else "info",
                "title": "Access refused",
                "count": len(refusals),
                "detail": (
                    f"{len(refusals)} refusal(s) in the last {hours}h; "
                    f"most by {worst} ({worst_count})"
                ),
            }
        )

    if not alerts:
        alerts.append(
            {
                "id": "quiet",
                "severity": "ok",
                "title": "Nothing to report",
                "count": 0,
                "detail": f"No failed sign-ins or refusals in the last {hours}h.",
            }
        )

    return {
        "windowHours": hours,
        "alerts": alerts,
        "recentDenials": [
            {
                "id": str(r.id),
                "ts": r.ts.isoformat(),
                "action": r.action,
                "outcome": r.outcome,
                "user": names.get(r.user_id, ""),
                "resourceType": r.resource_type,
                "requestId": r.request_id,
            }
            for r in denials[:50]
        ],
        "activity": _per_hour(rows, hours),
    }


def _per_hour(rows, hours: int) -> list[dict]:
    """Events per hour across the window, oldest first.

    Every hour is present, including the empty ones: a sparse series drawn
    as a line implies activity across a gap where there was none.
    """
    now = _now().replace(minute=0, second=0, microsecond=0)
    buckets = {now - timedelta(hours=offset): 0 for offset in range(hours)}
    for row in rows:
        hour = row.ts.replace(minute=0, second=0, microsecond=0)
        if hour.tzinfo is None:
            hour = hour.replace(tzinfo=timezone.utc)
        if hour in buckets:
            buckets[hour] += 1
    return [
        {"hour": hour.isoformat(), "count": count}
        for hour, count in sorted(buckets.items())
    ]
