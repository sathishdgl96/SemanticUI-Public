"""Certifying a semantic view, and who Snowflake says may do it.

The app does not decide. `SHOW SEMANTIC VIEWS` reports the role that owns a
view, and the caller's own connection is asked whether their session holds it.
That keeps the property the rest of the product rests on: this app never
widens anybody's rights, and it does not invent a governance permission of its
own that somebody could be granted from inside the app.

Every path that cannot establish authority refuses. A trust control that fails
open is worse than no control, because it produces a badge nobody checked.
"""

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ModelCertification, User
from app.semantic.discovery import execute_dicts

#: Which question to ask for each kind of owner Snowflake reports.
#: IS_ROLE_IN_SESSION only answers for account roles -- asking it about a
#: database role returns FALSE for somebody who genuinely owns the view, which
#: fails safe but makes certification impossible on accounts that own their
#: views that way. Anything not named here is refused rather than guessed at.
_CHECKS = {
    "ROLE": "IS_ROLE_IN_SESSION",
    "DATABASE_ROLE": "IS_DATABASE_ROLE_IN_SESSION",
}


def may_certify(conn: Any, owner: str | None, owner_role_type: str | None) -> bool:
    """Does this session hold the role that owns the view?

    True only when Snowflake says so in as many words. An unreadable owner, an
    owner kind we do not recognise, a NULL answer (which is what a shared
    object reached through a consumer account returns), an empty result, or a
    failed statement all mean no.
    """
    function = _CHECKS.get((owner_role_type or "").upper())
    if not owner or function is None:
        return False
    try:
        rows = execute_dicts(
            conn, f"SELECT {function}(%s) AS PERMITTED", (owner,)
        )
    except Exception:
        return False
    if not rows:
        return False
    # `is True` and not truthiness: NULL arrives as None, and "cannot tell"
    # must never read as permission.
    return rows[0].get("permitted") is True


def get(
    db: Session, database: str, schema: str, name: str
) -> ModelCertification | None:
    """The record for one view, or None if nobody has ever spoken for it.

    Absence is a real answer -- "not certified" -- rather than a missing one,
    so no row is written until somebody actually certifies or names an owner.
    """
    return db.execute(
        select(ModelCertification).where(
            ModelCertification.database == database,
            ModelCertification.schema == schema,
            ModelCertification.name == name,
        )
    ).scalar_one_or_none()


def put(
    db: Session,
    database: str,
    schema: str,
    name: str,
    *,
    user: User,
    role: str,
    certified: bool,
    owner_name: str | None,
    owner_contact: str | None,
    note: str | None,
) -> ModelCertification:
    """Write the whole record. Authority is the caller's to have checked.

    Naming an owner is as much a governance act as certifying, so the same
    authority governs all of it and they are written together.
    """
    row = get(db, database, schema, name)
    if row is None:
        row = ModelCertification(
            id=uuid.uuid4(), database=database, schema=schema, name=name
        )
        db.add(row)

    row.certified = certified
    row.owner_name = owner_name
    row.owner_contact = owner_contact
    row.note = note
    if certified:
        row.certified_by_user_id = user.id
        row.certified_by_role = role
        row.certified_at = datetime.now(timezone.utc)
    else:
        # Clearing keeps the owner: an uncertified model still has somebody to
        # ask. What it must not keep is a certification timestamp, which would
        # read as a live claim.
        row.certified_at = None
    db.commit()
    db.refresh(row)
    return row


def certified_keys(db: Session) -> set[tuple[str, str, str]]:
    """Every certified view, as identity triples.

    One query for a whole listing rather than one per row -- the constant-query
    property every listing in this product holds.
    """
    rows = db.execute(
        select(
            ModelCertification.database,
            ModelCertification.schema,
            ModelCertification.name,
        ).where(ModelCertification.certified.is_(True))
    ).all()
    return {(r[0], r[1], r[2]) for r in rows}
