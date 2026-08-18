"""Execute: the MDX Excel sends, answered from the semantic query builder.

The first Execute the client ever sends carries NO statement at all -- it is
the vehicle for the BeginSession header (captured live, 2026-08-18). That one
is a successful no-op. Real MDX arrives in slice 3; until then a statement is
a clean fault rather than a hang -- see routes.py for which of those Excel
survives.
"""

from app.errors import ApiError
from app.xmla.soap import MDDATASET_NS


def empty_dataset() -> str:
    """The canonical answer to a statement-less Execute.

    Real SSAS replies with the EMPTY-namespace root, not an empty mddataset;
    ADOMD.NET rejects the mddataset variant as "unrecognizable" (verified on
    the wire, 2026-08-18), so the distinction is load-bearing.
    """
    return (
        '<ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        '<root xmlns="urn:schemas-microsoft-com:xml-analysis:empty"/>'
        "</return></ExecuteResponse>"
    )


def handle_execute(session, request) -> str:
    statement = (request.statement or "").strip()
    if not statement:
        return empty_dataset()
    raise ApiError(
        "XMLA_NOT_YET",
        400,
        "MDX execution is not implemented yet; only Discover works so far.",
    )
