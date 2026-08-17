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


#: One earlier exchange. `answer` is the model's own one-sentence explanation
#: -- never rows, which is what keeps data out of the prompt.
class Turn(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)
    answer: str = Field(default="", max_length=500)


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LENGTH)
    #: Bounded here as well as trimmed in the prompt: the cap is what stops a
    #: caller sending a megabyte of "history" the model would be charged for.
    history: list[Turn] = Field(default_factory=list, max_length=20)


@router.post("/api/reports/{report_id}/ask")
def ask_report(
    report_id: str,
    body: AskBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    provider = _override or get_provider()
    return service.ask(
        db,
        sess,
        report_id,
        body.question,
        history=[t.model_dump() for t in body.history],
        provider=provider,
    )
