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
    if raw.get("schemaVersion") == 1:
        raw = _v1_to_v2(raw)
    if raw.get("schemaVersion") == 2:
        raw = _v2_to_v3(raw)
    return raw


def _v1_to_v2(raw: dict) -> dict:
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


def _v2_to_v3(raw: dict) -> dict:
    if "pages" in raw:
        # Not a shape this migration understands; let the validator name it.
        return raw
    upgraded = {
        **raw,
        "schemaVersion": 3,
        "pages": [
            {
                "id": "p1",
                "name": "Page 1",
                "visuals": raw.get("visuals", []),
                # v2's top-level filters were labelled "Filters on this page"
                # in the UI, so they belong to the migrated page; the new
                # all-pages scope starts empty.
                "filters": raw.get("filters", []),
            }
        ],
        "filters": [],
    }
    upgraded.pop("visuals", None)
    return upgraded
