from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.cortex import service
from app.cortex.provider import get_provider
from app.cortex.spec import MAX_QUESTION_LENGTH
from app.db.base import get_db
from app.db.models import DbSession

router = APIRouter()

#: Tests swap the provider here rather than monkeypatching a module global in
#: several places. Cleared by an autouse fixture.
_override = None


def set_provider_override(provider) -> None:
    global _override
    _override = provider


def clear_provider_override() -> None:
    global _override
    _override = None


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)


@router.post("/api/reports/{report_id}/ask")
def ask_report(
    report_id: str,
    body: AskBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    provider = _override or get_provider()
    return service.ask(db, sess, report_id, body.question, provider=provider)
