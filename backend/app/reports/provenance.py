"""The About page's four blocks, assembled.

Composition only -- no SQL, no Snowflake. The caller gathers the certification
record and the freshness result and hands both here, which is what lets each
block fail independently: a model can be certified while its freshness is
unreadable, and the page must render either way.

Lineage and open issues are declared placeholders. They render with their real
shape and say they are not wired yet, because a block that quietly returned
nothing is indistinguishable from a model with no lineage and no problems --
and that is the wrong claim to make on a page whose whole job is to be
trustworthy.
"""

from app.db.models import ModelCertification

#: What the open-issues table will hold once it has a source. Declared now so
#: that wiring it later is a data change rather than a layout change. The
#: intended first signal is field drift: a visual, filter or hierarchy naming
#: a dimension or metric the semantic view no longer has.
_ISSUE_COLUMNS = ["Issue", "Where", "Detail"]

# Short by intent. The heading already names the section; a paragraph
# explaining what a section will one day contain is filler on a page whose
# job is to be scanned. What matters is that the section is DECLARED --
# silence here would be indistinguishable from a model with no lineage and
# no problems.
_LINEAGE_PLACEHOLDER = "Not yet available."

_ISSUES_PLACEHOLDER = "No automatic checks yet."


def build(
    *, view: dict, record: ModelCertification | None, freshness: dict
) -> dict:
    """The four blocks, ready to render."""
    return {
        "model": {
            "database": view["database"],
            "schema": view["schema"],
            "name": view["name"],
            "certified": bool(record and record.certified),
            "owner": {
                "name": record.owner_name if record else None,
                "contact": record.owner_contact if record else None,
            },
            # Present only while the claim is live. Clearing certification
            # keeps the owner -- somebody still has to be asked when the
            # numbers look wrong -- but it must not keep a timestamp that
            # would read as a standing endorsement.
            "certifiedBy": (
                {"role": record.certified_by_role, "at": record.certified_at}
                if record and record.certified
                else None
            ),
            "note": record.note if record else None,
        },
        "freshness": freshness,
        "lineage": {"available": False, "placeholder": _LINEAGE_PLACEHOLDER},
        "openIssues": {
            "available": False,
            "columns": list(_ISSUE_COLUMNS),
            "issues": [],
            "placeholder": _ISSUES_PLACEHOLDER,
        },
    }
