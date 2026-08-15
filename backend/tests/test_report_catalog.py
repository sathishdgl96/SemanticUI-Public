import pytest

from app.reports.catalog import (
    CATALOG,
    validate_wells,
    wells_to_query,
)


def test_catalog_contains_the_core_seven():
    assert set(CATALOG) == {"bar", "line", "area", "pie", "scatter", "table", "kpi"}


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
