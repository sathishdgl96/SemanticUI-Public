import pytest

from app.reports.catalog import (
    CATALOG,
    validate_wells,
    wells_to_query,
)


def test_catalog_offers_the_full_gallery():
    assert set(CATALOG) == {
        "bar", "hbar", "line", "area", "combo",
        "pie", "donut", "treemap", "funnel", "gauge",
        "scatter", "table", "matrix", "kpi", "multiCard", "slicer",
    }


def test_every_type_declares_wells_and_a_label():
    for name, spec in CATALOG.items():
        assert spec.wells, f"{name} has no wells"
        assert spec.label, f"{name} has no label"
        assert spec.type == name


def test_combo_maps_both_measure_wells_columns_first():
    dims, mets = wells_to_query(
        "combo",
        {"axis": ["A.DATE"], "values": ["A.REV"], "lineValues": ["A.MARGIN"]},
    )
    assert dims == ["A.DATE"]
    assert mets == ["A.REV", "A.MARGIN"]


def test_matrix_maps_rows_then_columns():
    dims, mets = wells_to_query(
        "matrix",
        {"rows": ["C.REGION"], "columns": ["C.SEGMENT"], "values": ["A.REV"]},
    )
    assert dims == ["C.REGION", "C.SEGMENT"]
    assert mets == ["A.REV"]


def test_a_slicer_has_a_dimension_and_no_measure():
    dims, mets = wells_to_query("slicer", {"field": ["C.REGION"]})
    assert dims == ["C.REGION"]
    assert mets == []
    assert validate_wells("slicer", {"field": []})


def test_bar_maps_axis_and_legend_to_dimensions():
    dims, mets = wells_to_query(
        "bar",
        {"axis": ["A.DATE"], "legend": ["C.REGION"], "values": ["A.REV", "A.QTY"]},
    )
    assert dims == ["A.DATE", "C.REGION"]
    assert mets == ["A.REV", "A.QTY"]


def test_scatter_puts_two_metrics_on_the_axes():
    dims, mets = wells_to_query(
        "scatter", {"x": ["A.REV"], "y": ["A.QTY"], "detail": ["C.REGION"]}
    )
    assert dims == ["C.REGION"]
    assert mets == ["A.REV", "A.QTY"]


def test_kpi_has_no_dimensions():
    dims, mets = wells_to_query("kpi", {"value": ["A.REV"]})
    assert dims == []
    assert mets == ["A.REV"]


def test_pie_requires_exactly_one_metric():
    assert validate_wells("pie", {"legend": ["C.REGION"], "values": ["A.REV"]}) == []
    problems = validate_wells(
        "pie", {"legend": ["C.REGION"], "values": ["A.REV", "A.QTY"]}
    )
    assert problems and "at most 1" in problems[0]


def test_missing_required_well_is_reported():
    problems = validate_wells("bar", {"axis": [], "legend": [], "values": ["A.REV"]})
    assert problems and "Axis" in problems[0]


def test_table_needs_at_least_one_field_overall():
    assert validate_wells("table", {"dimensions": ["C.REGION"], "metrics": []}) == []
    problems = validate_wells("table", {"dimensions": [], "metrics": []})
    assert problems and "at least one field" in problems[0]


def test_a_field_may_not_appear_in_two_wells():
    problems = validate_wells(
        "bar", {"axis": ["A.DATE"], "legend": ["A.DATE"], "values": ["A.REV"]}
    )
    assert problems and "more than one well" in problems[0]


def test_unknown_well_and_unknown_type_are_rejected():
    problems = validate_wells("bar", {"axis": ["A.DATE"], "values": ["A.REV"], "bogus": []})
    assert problems and "bogus" in problems[0]
    with pytest.raises(KeyError):
        wells_to_query("nosuchtype", {})


# --- hierarchy references --------------------------------------------------

HIERARCHIES = {"h1": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]}


def test_wells_to_query_is_unchanged_without_hierarchies():
    dims, mets = wells_to_query(
        "bar", {"axis": ["CUSTOMERS.REGION"], "values": ["ORDERS.TOTAL"]}
    )
    assert dims == ["CUSTOMERS.REGION"]
    assert mets == ["ORDERS.TOTAL"]


def test_a_hierarchy_reference_expands_to_every_level():
    """Import validates each returned ref against DESCRIBE, so every level a
    user could drill to has to be checked -- not just the top one."""
    dims, mets = wells_to_query(
        "bar",
        {"axis": ["hierarchy:h1"], "values": ["ORDERS.TOTAL"]},
        hierarchies=HIERARCHIES,
    )
    assert dims == ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"]
    assert mets == ["ORDERS.TOTAL"]


def test_hierarchy_and_plain_refs_mix_in_declaration_order():
    dims, _ = wells_to_query(
        "bar",
        {"axis": ["hierarchy:h1"], "legend": ["CUSTOMERS.SEGMENT"],
         "values": ["ORDERS.TOTAL"]},
        hierarchies=HIERARCHIES,
    )
    assert dims == [
        "CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY", "CUSTOMERS.SEGMENT"
    ]


def test_an_unknown_hierarchy_reference_is_dropped_rather_than_emitted_raw():
    """parse_definition already rejects undeclared hierarchy references, so
    reaching here means the caller passed no map. Emitting "hierarchy:h9" as
    a field reference would surface as a confusing unknown-dimension error."""
    dims, _ = wells_to_query(
        "bar", {"axis": ["hierarchy:h9"], "values": ["ORDERS.TOTAL"]}, hierarchies={}
    )
    assert dims == []


def test_every_type_accepts_an_aggregations_option():
    """Any type with a measure well can hold a fact, so the option that says
    how to aggregate it belongs to all of them."""
    for name, spec in CATALOG.items():
        assert "aggregations" in spec.options, name


def test_a_types_own_options_are_still_its_own():
    # The shared option must not quietly widen what each type declares.
    assert "stacked" in CATALOG["bar"].options
    assert "stacked" not in CATALOG["pie"].options
    assert "donut" in CATALOG["pie"].options
    assert "donut" not in CATALOG["bar"].options
