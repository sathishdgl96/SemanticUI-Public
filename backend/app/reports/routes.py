from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report
from app.reports import service
from app.reports.schema import parse_definition, to_export_document

router = APIRouter()


class DefinitionBody(BaseModel):
    definition: dict


def _summary(report: Report) -> dict:
    return {
        "id": str(report.id),
        "name": report.name,
        "view": {
            "database": report.view_database,
            "schema": report.view_schema,
            "name": report.view_name,
        },
        "updatedAt": report.updated_at.isoformat(),
    }


def _detail(report: Report) -> dict:
    return {**_summary(report), "definition": report.definition}


@router.get("/api/reports")
def list_reports(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    return {"reports": [_summary(r) for r in service.list_reports(db, sess.user_id)]}


@router.post("/api/reports", status_code=201)
def create_report(
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.create_report(db, sess.user_id, body.definition))


@router.get("/api/reports/{report_id}")
def get_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.get_owned_report(db, sess.user_id, report_id))


@router.put("/api/reports/{report_id}")
def update_report(
    report_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return _detail(service.update_report(db, sess.user_id, report_id, body.definition))


@router.delete("/api/reports/{report_id}", status_code=204)
def delete_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_report(db, sess.user_id, report_id)
    return Response(status_code=204)


@router.get("/api/reports/{report_id}/export")
def export_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    report = service.get_owned_report(db, sess.user_id, report_id)
    document = to_export_document(parse_definition(report.definition))
    return Response(content=document, media_type="application/json")
