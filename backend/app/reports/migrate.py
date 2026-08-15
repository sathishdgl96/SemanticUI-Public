"""Upgrade older definition documents to the current schema version.

Runs BEFORE pydantic validation, because the document model demands the
current `schemaVersion` exactly and forbids unknown keys -- a v1 document
would be rejected before anything got the chance to upgrade it.

Deliberately tolerant: anything malformed is passed through untouched so the
validator produces the error, rather than this module raising a second, less
specific one from further away.
"""


def migrate_definition(raw: object) -> object:
    """Return `raw` upgraded to the current schema version. Never mutates it."""
    if not isinstance(raw, dict):
        return raw
    if raw.get("schemaVersion") != 1:
        return raw

    upgraded = {
        **raw,
        "schemaVersion": 2,
        # setdefault semantics, not overwrite: a hand-written v1 document that
        # already carries these keys keeps what it says.
        "filters": raw.get("filters", []),
        "hierarchies": raw.get("hierarchies", []),
    }

    visuals = raw.get("visuals")
    if isinstance(visuals, list):
        upgraded["visuals"] = [
            {**v, "filters": v.get("filters", [])} if isinstance(v, dict) else v
            for v in visuals
        ]
    return upgraded
