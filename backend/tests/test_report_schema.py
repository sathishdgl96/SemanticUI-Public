import json

import pytest

from app.errors import ApiError
from app.reports.schema import (
    MAX_VISUALS,
    SCHEMA_VERSION,
    parse_definition,
    to_export_document,
)


def valid_doc(**overrides):
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "name": "Sales overview",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [
            {
                "id": "v1",
                "type": "bar",
                "title": "Revenue by region",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": ["C.REGION"], "legend": [], "values": ["A.REV"]},
                "options": {"stacked": False},
            }
        ],
    }
    doc.update(overrides)
    return doc


def test_parses_a_valid_document():
    d = parse_definition(valid_doc())
    assert d.name == "Sales overview"
    assert d.view.name == "SALES"
    assert d.visuals[0].type == "bar"
    assert d.visuals[0].layout.w == 6


def test_rejects_an_unsupported_schema_version():
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(schemaVersion=99))
    assert exc.value.code == "REPORT_INVALID"
    assert "schemaVersion" in exc.value.message


def test_rejects_unknown_top_level_and_visual_keys():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(surpriseKey="x"))
    doc = valid_doc()
    doc["visuals"][0]["surprise"] = 1
    with pytest.raises(ApiError):
        parse_definition(doc)


def test_rejects_an_unknown_visual_type():
    doc = valid_doc()
    doc["visuals"][0]["type"] = "hologram"
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "hologram" in exc.value.message


def test_rejects_well_cardinality_violations():
    doc = valid_doc()
    doc["visuals"][0]["wells"] = {"axis": [], "legend": [], "values": ["A.REV"]}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "Axis" in exc.value.message


def test_rejects_unknown_option_keys():
    doc = valid_doc()
    doc["visuals"][0]["options"] = {"stacked": False, "rainbow": True}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "rainbow" in exc.value.message


def test_rejects_duplicate_visual_ids():
    doc = valid_doc()
    doc["visuals"].append(dict(doc["visuals"][0]))
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "duplicate" in exc.value.message.lower()


def test_rejects_too_many_visuals():
    doc = valid_doc()
    base = doc["visuals"][0]
    doc["visuals"] = [dict(base, id=f"v{i}") for i in range(MAX_VISUALS + 1)]
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert str(MAX_VISUALS) in exc.value.message


def test_export_document_is_deterministic_and_sorted():
    a = to_export_document(parse_definition(valid_doc()))
    b = to_export_document(parse_definition(valid_doc()))
    assert a == b
    parsed = json.loads(a)
    assert list(parsed) == sorted(parsed)
    # No identity, timestamps or ids leak into the portable document.
    assert "owner" not in a and "createdAt" not in a and "updatedAt" not in a
    assert a.endswith("\n")


def test_validation_errors_do_not_echo_the_submitted_value():
    marker = "SENSITIVE-MARKER-VALUE"
    doc = valid_doc()
    doc["visuals"][0]["layout"] = {"x": marker, "y": 0, "w": 6, "h": 6}
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert marker not in str(exc.value.detail or "")
    assert marker not in exc.value.message
    # The path and reason must survive — the point is redaction, not silence.
    assert "layout" in str(exc.value.detail)
