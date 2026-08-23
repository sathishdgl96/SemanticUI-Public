r"""Execute: the MDX Excel sends, answered from the semantic query builder.

The statement-less Execute is BeginSession's vehicle and answers with the
empty-namespace root. Real statements go through the mdx parser, become one
or more semantic queries on the CALLER'S OWN connection, and come back as
the mddataset shape Excel accepts (see dataset.py).

The engine supports what Excel's pivot engine emits, learned from the wire:
up to two axes, each carrying a measure set and/or ONE attribute-hierarchy
drill; WHERE tuples and subselects as filters. An axis with an All-member
drill answers the All tuple from a coarser aggregate query -- one query per
distinct grouping the axes require (at most four), all on one connection.

This module is the package's Execute facade; the work lives in three
siblings: classify.py (axis expressions -> HierSpec), members.py (member
rendering and DisplayInfo), engine.py (queries, tuples, cells). `gateway`
is re-exported because tests patch `execute.gateway.run_query`.
"""

from app.errors import ApiError
from app.snowflake import gateway
from app.xmla.engine import _Engine
from app.xmla.mdx import MdxUnsupported, parse_mdx

__all__ = ["empty_dataset", "handle_execute", "gateway"]


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
    try:
        q = parse_mdx(statement)
    except MdxUnsupported as exc:
        raise ApiError("XMLA_MDX", 400, f"unsupported MDX: {exc}") from exc

    view = None
    for v in session.list_views():
        from app.xmla.discover import cube_name

        if cube_name(v).upper() == q.cube.upper():
            view = v
            break
    if view is None:
        raise ApiError("XMLA_MDX", 404, f"unknown cube {q.cube!r}")
    detail = session.describe(view["database"], view["schema"], view["name"])
    # A composite model is a cube too. Everything about MDX is the same
    # for it; only the route from fields to SQL differs, so it subclasses
    # the engine rather than forking it.
    from app.xmla.composite_engine import build_engine
    from app.xmla.composite_source import is_composite

    engine = None
    if is_composite(view):
        definition = session.model_definition(
            view["database"], view["schema"], view["name"]
        )
        engine = build_engine(session, view, detail, q, definition)
    if engine is None:
        engine = _Engine(session, view, detail, q)
    try:
        return engine.execute()
    except MdxUnsupported as exc:
        raise ApiError("XMLA_MDX", 400, f"unsupported MDX: {exc}") from exc
