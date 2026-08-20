"""Read and change the session's execution context."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, User
from app.session import context
from app.snowflake.provider import get_cache

router = APIRouter()


class ContextBody(BaseModel):
    #: Absent means "leave it alone", which is how the UI changes one
    #: without disturbing the other.
    role: str | None = None
    warehouse: str | None = None


@router.get("/api/session/context")
def read_context(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        roles = context.available_roles(entry.conn)
        warehouses = context.available_warehouses(entry.conn)
    user = db.get(User, sess.user_id)
    return {
        "role": user.last_role,
        "warehouse": user.last_warehouse,
        "roles": roles,
        "warehouses": warehouses,
    }


@router.post("/api/session/context")
def set_context(
    body: ContextBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        # Resolved against what Snowflake just said, and refused before
        # anything is applied -- a rejected choice must leave the
        # connection exactly as it was.
        role = context.resolve(body.role, context.available_roles(entry.conn), "role")
        warehouse = context.resolve(
            body.warehouse, context.available_warehouses(entry.conn), "warehouse"
        )
        context.apply_context(entry.conn, role, warehouse)

    user = db.get(User, sess.user_id)
    if role:
        user.last_role = role
    if warehouse:
        user.last_warehouse = warehouse
    db.commit()

    from app.audit import record

    # Shapes only: which role was assumed, never what was queried with it.
    record(
        db,
        "session.context",
        user_id=sess.user_id,
        session_id=sess.id,
        detail={"role": role, "warehouse": warehouse},
    )
    return {"role": user.last_role, "warehouse": user.last_warehouse}
