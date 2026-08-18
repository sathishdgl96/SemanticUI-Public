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
    """A well-formed, empty mddataset ExecuteResponse."""
    return (
        '<ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        f'<root xmlns="{MDDATASET_NS}" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema"/>'
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
