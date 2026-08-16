import re

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession
from app.export import service
from app.reports.schema import MAX_VISUALS

router = APIRouter()

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

#: Anything that would break a Content-Disposition header or a filesystem.
_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\r\n]+')


class SheetRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    dimensions: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    filters: list[dict] = Field(default_factory=list)
    orderBy: list[dict] = Field(default_factory=list)
    #: Free text describing drill position or cross-filter. Recorded on the
    #: Summary sheet; never interpreted.
    context: str = Field(default="", max_length=500)


class ExportBody(BaseModel):
    sheets: list[SheetRequest] = Field(default_factory=list, max_length=MAX_VISUALS)


def _filename(report_name: str) -> str:
    cleaned = _UNSAFE_FILENAME.sub("", report_name).strip() or "report"
    return f"{cleaned[:120]}.xlsx"


@router.post("/api/reports/{report_id}/export.xlsx")
def export_xlsx(
    report_id: str,
    body: ExportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    name, data = service.export_workbook(
        db, sess, report_id, [s.model_dump() for s in body.sheets]
    )
    return Response(
        content=data,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{_filename(name)}"'},
    )


@router.post("/api/reports/{report_id}/connect")
def connect(
    report_id: str,
    body: ExportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return service.connection_details(
        db, sess, report_id, [s.model_dump() for s in body.sheets]
    )
