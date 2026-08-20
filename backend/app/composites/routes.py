"""Composite model endpoints.

Every one resolves the composite through the workspace gate before
touching anything, so a stranger cannot read, change or learn the
existence of a model they may not open.

What is recorded is shapes -- how many members, how many shared
dimensions -- and never a view name, a table or a column. A composite's
definition names warehouse objects, and the audit trail is value-free by
contract precisely so it can be shown to an operator in full.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit import record
from app.auth.routes import current_session
from app.composites import service
from app.db.base import get_db
from app.db.models import DbSession

router = APIRouter()


class CreateBody(BaseModel):
    name: str = Field(default="Untitled model", max_length=200)
    workspaceId: str | None = None


class DefinitionBody(BaseModel):
    definition: dict


def _shape(composite) -> dict:
    definition = composite.definition or {}
    return {
        "members": len(definition.get("members") or []),
        "sharedDimensions": len(definition.get("sharedDimensions") or []),
        "derivedMetrics": len(definition.get("derivedMetrics") or []),
    }


@router.get("/api/composites")
def list_composites(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    from app.library.search import MAX_ROWS

    rows = service.list_composites(db, sess.user_id, workspace)
    return {"composites": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}


@router.post("/api/composites", status_code=201)
def create_composite(
    body: CreateBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.create_composite(db, sess.user_id, body.name, body.workspaceId)
    record(db, "composite.create", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id)
    return service.detail(db, sess.user_id, composite)


@router.get("/api/composites/{composite_id}")
def get_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.get_composite(db, sess.user_id, composite_id)
    record(db, "composite.read", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id)
    return service.detail(db, sess.user_id, composite)


@router.put("/api/composites/{composite_id}")
def update_composite(
    composite_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.update_composite(
        db, sess.user_id, composite_id, body.definition
    )
    record(db, "composite.update", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id,
           detail=_shape(composite))
    return service.detail(db, sess.user_id, composite)


@router.delete("/api/composites/{composite_id}", status_code=204)
def delete_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
):
    from fastapi import Response

    service.delete_composite(db, sess.user_id, composite_id)
    record(db, "composite.delete", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite_id)
    return Response(status_code=204)
