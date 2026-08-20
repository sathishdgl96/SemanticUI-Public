"""Dashboard endpoints.

Every one resolves the dashboard (and, when pinning, the report) through
the workspace gate before touching anything -- so a stranger cannot pin
to, read, or learn the existence of a dashboard they may not open.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.dashboards import service
from app.db.base import get_db
from app.db.models import DbSession

router = APIRouter()


class CreateBody(BaseModel):
    name: str = Field(default="Untitled dashboard", max_length=200)
    workspaceId: str | None = None


class DefinitionBody(BaseModel):
    definition: dict


class TileBody(BaseModel):
    reportId: str = Field(max_length=64)
    pageId: str = Field(max_length=64)
    visualId: str = Field(max_length=64)
    title: str | None = Field(default=None, max_length=200)


class HomeBody(BaseModel):
    #: Null clears the choice, which is how "show me the picker again" is
    #: expressed.
    dashboardId: str | None = None


@router.get("/api/dashboards")
def list_dashboards(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return {"dashboards": service.list_dashboards(db, sess.user_id, workspace)}


@router.post("/api/dashboards", status_code=201)
def create_dashboard(
    body: CreateBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    dashboard = service.create_dashboard(db, sess.user_id, body.name, body.workspaceId)
    return service.detail(db, sess.user_id, dashboard)


@router.get("/api/dashboards/{dashboard_id}")
def get_dashboard(
    dashboard_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    dashboard = service.get_dashboard(db, sess.user_id, dashboard_id)
    return service.detail(db, sess.user_id, dashboard)


@router.put("/api/dashboards/{dashboard_id}")
def update_dashboard(
    dashboard_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    dashboard = service.update_dashboard(
        db, sess.user_id, dashboard_id, body.definition
    )
    return service.detail(db, sess.user_id, dashboard)


@router.delete("/api/dashboards/{dashboard_id}", status_code=204)
def delete_dashboard(
    dashboard_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    service.delete_dashboard(db, sess.user_id, dashboard_id)


@router.post("/api/dashboards/{dashboard_id}/tiles", status_code=201)
def add_tile(
    dashboard_id: str,
    body: TileBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return service.add_tile(
        db,
        sess.user_id,
        dashboard_id,
        body.reportId,
        body.pageId,
        body.visualId,
        body.title,
    )


@router.delete("/api/dashboards/{dashboard_id}/tiles/{tile_id}", status_code=204)
def remove_tile(
    dashboard_id: str,
    tile_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    service.remove_tile(db, sess.user_id, dashboard_id, tile_id)


@router.put("/api/home/dashboard")
def set_home_dashboard(
    body: HomeBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    service.set_home_dashboard(db, sess.user_id, body.dashboardId)
    return {"dashboardId": body.dashboardId}
