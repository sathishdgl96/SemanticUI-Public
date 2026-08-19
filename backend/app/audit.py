"""The audit trail: who did what, correlated, value-free.

`record` is called at the funnels -- the auth endpoints, the single
authorization gate, the token mint, the export/feed/XMLA entry points --
never sprinkled through business logic. Every event carries the request
id from the logging contextvars, so an audit row joins the log stream
and, through the query id logged there, Snowflake's own QUERY_HISTORY.

Two contracts, both deliberate:

* VALUE-FREE. `detail` holds shapes (counts, flags, durations), never
  data values, resource NAMES, or tokens. A denied access records that a
  denial happened to a resource id -- not what the resource was called.
* NEVER the reason a request fails. The writer swallows and logs its own
  errors; a broken audit database must not take the product down with it
  (the gap is itself logged, loudly).
"""

import hashlib
import logging

from sqlalchemy.orm import Session

from app.db.models import AuditEvent
from app.logging import request_id_var

logger = logging.getLogger(__name__)


def session_ref(session_id: str | None) -> str | None:
    """A short hash of the session id: correlates a session's events
    without storing the cookie value itself."""
    if not session_id:
        return None
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


def record(
    db: Session,
    action: str,
    *,
    user_id=None,
    session_id: str | None = None,
    resource_type: str | None = None,
    resource_id=None,
    outcome: str = "ok",
    detail: dict | None = None,
) -> None:
    """Write one audit event on the caller's DB session and commit.

    Call sites sit where a commit is safe: after their own commit, or on
    deny/fail paths where nothing is pending.
    """
    try:
        db.add(AuditEvent(
            request_id=request_id_var.get(),
            user_id=user_id,
            session_ref=session_ref(session_id),
            action=action,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id is not None else None,
            outcome=outcome,
            detail=detail,
        ))
        db.commit()
    except Exception:
        logger.exception("audit write failed for %s", action)
        try:
            db.rollback()
        except Exception:
            logger.exception("audit rollback failed")
