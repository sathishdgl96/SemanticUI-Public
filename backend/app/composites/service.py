"""Composite models: one model over several semantic views.

Two rules carry the design, and both are about not widening access.

**A composite holds a definition, never data.** It names member views
and says which of their columns mean the same thing. Every query it
takes part in still runs on the caller's own Snowflake connection
against those member views, so a composite cannot show anybody a number
they could not already have asked for (ADR 0001). Sharing one shares a
mapping.

**Membership governs the definition; Snowflake governs the data.** Being
in the workspace lets a person open and edit the model. It grants
nothing at all in the warehouse -- a member view the caller cannot
SELECT refuses them here in Snowflake's own words, exactly as it would
if they had queried it directly.

Members are deliberately *not* checked against the workspace: a semantic
view is not a workspace-owned object, it is a warehouse object with its
own grants. Constraining which views a composite may name would be this
app inventing an access rule Snowflake did not ask for.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.composites.schema import blank, parse_definition
from app.db.models import CompositeModel, Workspace
from app.library import provenance, state
from app.reports.service import personal_workspace_id
from app.workspaces.access import (
    as_uuid,
    membership,
    require_owned,
    require_workspace,
    roles_for,
    workspaces_by_id,
)


def _summary(
    composite: CompositeModel,
    *,
    workspace: Workspace | None,
    role: str,
    creator: str = "",
) -> dict:
    definition = composite.definition or {}
    members = definition.get("members") or []
    return {
        "id": str(composite.id),
        "name": composite.name,
        "workspaceId": str(composite.workspace_id),
        "workspaceName": workspace.name if workspace else "",
        "myRole": role,
        #: What the browse list shows in the detail column, the way a
        #: dashboard shows its tile count.
        "memberCount": len(members),
        "updatedAt": composite.updated_at.isoformat() if composite.updated_at else None,
        #: Who made it. Provenance, never permission (ADR 0009).
        "createdBy": creator,
    }


def list_composites(
    db: Session, user_id: uuid.UUID, workspace_id: str | None
) -> list[dict]:
    """Every composite this user can see, optionally in one workspace.

    Scoped by JOINing membership rather than by listing then filtering:
    a row a caller may not read must never leave the database.
    """
    from app.db.models import WorkspaceMember
    from app.library.search import MAX_ROWS

    query = (
        select(CompositeModel)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == CompositeModel.workspace_id,
        )
        .where(WorkspaceMember.user_id == user_id)
    )
    if workspace_id:
        key = as_uuid(workspace_id)
        if key is None:
            return []
        query = query.where(CompositeModel.workspace_id == key)
    rows = db.scalars(
        query.order_by(CompositeModel.updated_at.desc()).limit(MAX_ROWS + 1)
    ).all()

    favorites = state.favorite_ids(db, user_id, "composite")
    recents = state.recent_order(db, user_id, "composite")
    creators = provenance.creator_names(db, [row.owner_user_id for row in rows])
    # Prefetched rather than per row: the alternative is two queries a
    # composite, which is one round trip for the list and eighty more for
    # forty of them.
    roles = roles_for(db, user_id)
    spaces = workspaces_by_id(db, [row.workspace_id for row in rows])
    out = []
    for row in rows:
        summary = _summary(
            row,
            workspace=spaces.get(row.workspace_id),
            role=roles.get(row.workspace_id, ""),
            creator=creators.get(row.owner_user_id, ""),
        )
        summary["favorite"] = row.id in favorites
        seen = recents.get(row.id)
        summary["lastViewedAt"] = seen.isoformat() if seen else None
        out.append(summary)
    return out


def create_composite(
    db: Session, user_id: uuid.UUID, name: str, workspace_id: str | None
) -> CompositeModel:
    # The named workspace, or mine -- the same rule the other three kinds
    # follow.
    target = (
        require_workspace(db, user_id, workspace_id, need="editor").id
        if workspace_id
        else personal_workspace_id(db, user_id)
    )
    clean = (name or "").strip()[:200] or "Untitled model"
    composite = CompositeModel(
        owner_user_id=user_id,
        workspace_id=target,
        name=clean,
        definition=blank(clean),
    )
    db.add(composite)
    db.commit()
    db.refresh(composite)
    return composite


def get_composite(db: Session, user_id: uuid.UUID, composite_id: str) -> CompositeModel:
    return require_owned(db, user_id, composite_id, CompositeModel, need="viewer")


def update_composite(
    db: Session, user_id: uuid.UUID, composite_id: str, definition: dict
) -> CompositeModel:
    composite = require_owned(db, user_id, composite_id, CompositeModel, need="editor")
    parsed = parse_definition(definition)
    # by_alias, or `schema` comes back as `schema_` and the document stops
    # round-tripping through its own parser.
    composite.definition = parsed.model_dump(by_alias=True)
    composite.name = parsed.name
    db.commit()
    db.refresh(composite)
    return composite


def delete_composite(db: Session, user_id: uuid.UUID, composite_id: str) -> None:
    composite = require_owned(db, user_id, composite_id, CompositeModel, need="editor")
    # Favourites and recents point at it by id. Left behind they would be
    # rows nothing can resolve, and a stale favourite is a link that
    # always 404s.
    state.forget_item(db, "composite", composite.id)
    db.delete(composite)
    db.commit()


def detail(db: Session, user_id: uuid.UUID, composite: CompositeModel) -> dict:
    workspace = db.get(Workspace, composite.workspace_id)
    member = membership(db, user_id, composite.workspace_id)
    creators = provenance.creator_names(db, [composite.owner_user_id])
    out = _summary(
        composite,
        workspace=workspace,
        role=member.role if member else "",
        creator=creators.get(composite.owner_user_id, ""),
    )
    out["definition"] = composite.definition or {}
    return out
