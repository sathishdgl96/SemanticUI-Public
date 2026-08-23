"""/api/export and /api/connect: workbooks, connect tokens, ODC files.

Exported documents carry no identity and no credentials. The connect
token is minted here, shown once, and stored only as a hash; filenames
are sanitised because they derive from report names.
"""

import re

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import connect_token
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


@router.post("/api/connect/token")
def create_connect_token(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Mint the Excel/Power Query bearer for the calling session.

    Shown once by the UI and never retrievable again; minting again replaces
    the previous token, which is also how a user revokes one deliberately.
    """
    token, expires = connect_token.mint(db, sess)
    from app.audit import record

    record(db, "token.mint", user_id=sess.user_id, session_id=sess.id,
           detail={"expiresAt": expires.isoformat()})
    return {"token": token, "expiresAt": expires.isoformat()}


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


class OdcBody(BaseModel):
    #: One sheet, because one ODC file holds one query. A report with four
    #: visuals is four downloads, which is also four tables in Excel.
    sheet: SheetRequest
    #: Optional: the warehouse Excel should use. Absent means the user's
    #: default, which is what most people want and nobody has to be told.
    warehouse: str = Field(default="", max_length=255)


@router.post("/api/reports/{report_id}/connect.odc")
def connect_odc(
    report_id: str,
    body: OdcBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The Connect panel's four manual steps, as a file you double-click.

    Carries no credential: Excel prompts for a sign-in and refreshes as
    whoever opened it. See app/export/odc.py.
    """
    document, filename = service.connection_file(
        db, sess, report_id, body.sheet.model_dump(), warehouse=body.warehouse
    )
    return Response(
        content=document,
        media_type="text/x-ms-odc",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
