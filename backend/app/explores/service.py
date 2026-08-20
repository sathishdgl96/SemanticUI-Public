"""Saved explores: ad-hoc explorer sessions persisted like documents.

Same ownership model as reports: workspace-scoped, membership checked
at the gate, owner_user_id as provenance only.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import SavedExplore, WorkspaceMember
from app.explores.schema import ExploreDefinition, parse_definition
from app.library import search, state
from app.library.search import LibraryQuery
from app.reports.service import personal_workspace_id
from app.workspaces.access import require_owned, require_workspace


def list_explores(
    db: Session,
    user_id: uuid.UUID,
    workspace_id: str | None = None,
    params: LibraryQuery | None = None,
) -> list[SavedExplore]:
    """Every explore in every workspace this user belongs to.

    Joined through membership rather than filtered on `owner_user_id`: a
    shared explore is not owned by the person reading it.
    """
    query = (
        select(SavedExplore)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == SavedExplore.workspace_id,
        )
        .where(WorkspaceMember.user_id == user_id)
        .order_by(SavedExplore.updated_at.desc())
    )
    if workspace_id:
        # Through require_workspace, so a bogus or unauthorised id is a 404
        # rather than an empty list that reads as "no explores here".
        workspace = require_workspace(db, user_id, workspace_id, need="viewer")
        query = query.where(SavedExplore.workspace_id == workspace.id)
    # Narrowing only, and only after the membership join above.
    params = params or LibraryQuery()
    query = search.apply(query, SavedExplore, params)
    items = list(db.scalars(query))
    favorites = state.favorite_ids(db, user_id, "explore")
    recents = state.recent_order(db, user_id, "explore")
    items = search.keep_favorites(items, params, favorites)
    return search.order_items(items, params, recents, favorites)


def _target(db: Session, user_id: uuid.UUID, workspace_id: str | None) -> uuid.UUID:
    if workspace_id:
        return require_workspace(db, user_id, workspace_id, need="editor").id
    return personal_workspace_id(db, user_id)


def _apply(explore: SavedExplore, definition: ExploreDefinition) -> None:
    explore.name = definition.name
    explore.view_database = definition.view.database
    explore.view_schema = definition.view.schema_
    explore.view_name = definition.view.name
    explore.definition = definition.model_dump(by_alias=True, mode="json")


def create_explore(
    db: Session,
    user_id: uuid.UUID,
    raw_definition: dict,
    workspace_id: str | None = None,
) -> SavedExplore:
    target = _target(db, user_id, workspace_id)
    definition = parse_definition(raw_definition)
    explore = SavedExplore(
        owner_user_id=user_id,
        workspace_id=target,
        name=definition.name,
        view_database="",
        view_schema="",
        view_name="",
        definition={},
    )
    _apply(explore, definition)
    db.add(explore)
    db.commit()
    db.refresh(explore)
    return explore


def get_explore(db: Session, user_id: uuid.UUID, explore_id: str) -> SavedExplore:
    return require_owned(db, user_id, explore_id, SavedExplore, need="viewer")


def update_explore(
    db: Session, user_id: uuid.UUID, explore_id: str, raw_definition: dict
) -> SavedExplore:
    explore = require_owned(db, user_id, explore_id, SavedExplore, need="editor")
    _apply(explore, parse_definition(raw_definition))
    db.commit()
    db.refresh(explore)
    return explore


def delete_explore(db: Session, user_id: uuid.UUID, explore_id: str) -> None:
    explore = require_owned(db, user_id, explore_id, SavedExplore, need="editor")
    state.forget_item(db, "explore", explore.id)
    db.delete(explore)
    db.commit()
