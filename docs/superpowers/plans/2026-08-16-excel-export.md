# Excel Export & Live Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download a report as an `.xlsx` workbook of exactly what is on screen, and get the SQL needed to wire Excel up to Snowflake directly.

**Architecture:** Export is a POST carrying, per visual, the same resolved wells and effective filters the tile already sends to `/api/query/semantic` — so "what is on screen" needs no new server state. Each entry is validated and run on the caller's own connection, then written into a sheet. A separate, never-executed function produces copyable SQL with values inlined, for Excel's native Snowflake connector.

**Tech Stack:** FastAPI + pydantic v2 + `xlsxwriter` (backend), React 18 + TypeScript + TanStack Query (frontend), pytest + `openpyxl` (reading workbooks back in tests), vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-16-excel-export-design.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Formula injection is the thing this feature would otherwise get wrong.** The workbook is created with `strings_to_formulas=False` and every text value is written with `write_string`. A value beginning `=`, `+`, `-` or `@` must display exactly as stored and never be evaluated.
- **The copyable literal SQL is a separate code path.** It lives in a module that never touches a cursor, is never executed by this application, and a test asserts the executable builder still emits `?` placeholders.
- **Every query runs on `entry.conn`** — the caller's own connection. Export changes nothing about credentials.
- **Per-sheet failure keeps the workbook.** One visual raising `SNOWFLAKE_FORBIDDEN` puts the error in that sheet; the rest still carry data.
- Exporting and copying SQL both need only `viewer`.
- Limits: **100,000 rows per sheet**, **50 sheets**, `export_row_cap` default **100000**. Truncation is declared on the Summary sheet, never silent.
- Sheet names: Excel forbids `[ ] : * ? / \`, caps at 31 characters, requires uniqueness. Collisions get a numeric suffix rather than overwriting.
- Backend endpoints are sync `def` (not `async def`).
- Frontend: run `npm run typecheck` (`tsc -b`). Bare `tsc --noEmit` checks **nothing**.
- **Never modify or reorder `frontend/src/query/palette.ts`.**
- Layout holds at 1440 / 1280 / 1024 / 768 / 390px; focus outlines never removed; hit targets clear 24px.
- Give every `<select>`/`<input>` an explicit `htmlFor`/`id` — a wrapping `<label>` folds a select's option text into its accessible name.

## File Structure

**Backend — created:**
- `app/export/__init__.py`
- `app/export/sheets.py` — sheet-name sanitising and the cell-writing rules. Pure, no Snowflake, no HTTP.
- `app/export/workbook.py` — builds the workbook from already-fetched results. Takes data in, returns bytes.
- `app/export/literals.py` — copyable SQL with values inlined. **Never touches a cursor.**
- `app/export/service.py` — runs each sheet's query on the caller's connection and hands results to `workbook.py`.
- `app/export/routes.py` — `POST /api/reports/{id}/export.xlsx`, `GET /api/reports/{id}/connect`.

**Backend — modified:**
- `pyproject.toml` — add `xlsxwriter`; add `openpyxl` to the dev extra (tests read workbooks back).
- `app/config.py` — `export_row_cap`.
- `app/main.py` — register the router.

**Frontend — created:**
- `src/api/exports.ts`, `src/export/ConnectPanel.tsx`

**Frontend — modified:**
- `src/api/types.ts`, `src/reports/BuilderPage.tsx`, `src/index.css`

---

## Task 1: Cell and sheet-name rules

The security-relevant task. Pure functions, no I/O, so the rules can be asserted directly.

**Files:**
- Create: `backend/app/export/__init__.py`, `backend/app/export/sheets.py`
- Modify: `backend/pyproject.toml`, `backend/app/config.py`
- Test: `backend/tests/test_export_sheets.py`

**Interfaces:**
- Produces:
  - `FORMULA_PREFIXES = ("=", "+", "-", "@")`
  - `MAX_SHEET_NAME = 31`
  - `safe_sheet_name(title: str, taken: set[str]) -> str`
  - `looks_like_formula(value: object) -> bool`
  - `settings.export_row_cap` (default `100000`)

- [ ] **Step 1: Add the dependencies**

In `backend/pyproject.toml`, add `"xlsxwriter>=3.2"` to `dependencies`, and
`"openpyxl>=3.1"` to the `dev` extra — tests read the generated workbook back
rather than trusting the writer.

Run: `cd backend && .venv/Scripts/python.exe -m pip install "xlsxwriter>=3.2" "openpyxl>=3.1"`

In `backend/app/config.py`, add to `Settings`:

```python
    #: Rows per exported sheet. Deliberately far above the 10,000 display cap:
    #: an export is meant to be complete, a screen is not.
    export_row_cap: int = 100000
```

- [ ] **Step 2: Write the failing test**

```python
# backend/tests/test_export_sheets.py
import pytest

from app.export.sheets import (
    FORMULA_PREFIXES,
    MAX_SHEET_NAME,
    looks_like_formula,
    safe_sheet_name,
)


class TestFormulaDetection:
    """A warehouse value beginning = + - or @ is a FORMULA to whoever opens the
    file. The data is not ours and the reader is not us."""

    def test_every_dangerous_prefix_is_detected(self):
        for prefix in FORMULA_PREFIXES:
            assert looks_like_formula(f"{prefix}cmd|'/c calc'!A0") is True

    def test_the_classic_payloads_are_detected(self):
        for payload in (
            "=cmd|'/c calc'!A0",
            '=HYPERLINK("http://evil","click")',
            "+HYPERLINK(1)",
            "-2+3+cmd|' /C calc'!A0",
            "@SUM(1+1)*cmd|' /C calc'!A0",
        ):
            assert looks_like_formula(payload) is True

    def test_ordinary_text_is_not(self):
        for value in ("EAST", "Q1 2026", "a-b", "sales@example.com", ""):
            assert looks_like_formula(value) is False

    def test_leading_whitespace_does_not_hide_a_formula(self):
        """Excel tolerates a leading space; a naive startswith does not."""
        assert looks_like_formula("  =1+1") is True
        assert looks_like_formula("\t=1+1") is True

    def test_numbers_are_not_formulas(self):
        assert looks_like_formula(-5) is False
        assert looks_like_formula(3.14) is False
        assert looks_like_formula(None) is False


class TestSheetNames:
    def test_a_plain_title_survives(self):
        assert safe_sheet_name("Revenue by region", set()) == "Revenue by region"

    def test_forbidden_characters_are_removed(self):
        """Excel refuses [ ] : * ? / \\ outright -- a workbook containing one
        fails to open at all."""
        assert safe_sheet_name("A/B:C*D?E[F]G\\H", set()) == "ABCDEFGH"

    def test_names_are_capped_at_excels_limit(self):
        name = safe_sheet_name("x" * 60, set())
        assert len(name) <= MAX_SHEET_NAME

    def test_a_duplicate_is_disambiguated_not_overwritten(self):
        taken = {"Revenue"}
        assert safe_sheet_name("Revenue", taken) == "Revenue (2)"

    def test_repeated_duplicates_keep_counting(self):
        taken = {"Revenue", "Revenue (2)"}
        assert safe_sheet_name("Revenue", taken) == "Revenue (3)"

    def test_a_long_duplicate_still_fits(self):
        """The suffix must not push the name past the cap."""
        long = "y" * 31
        name = safe_sheet_name(long, {long})
        assert len(name) <= MAX_SHEET_NAME
        assert name != long

    def test_an_empty_title_gets_a_usable_name(self):
        """An untitled visual is normal; a nameless sheet is not allowed."""
        assert safe_sheet_name("", set())
        assert safe_sheet_name("   ", set())

    def test_a_title_of_only_forbidden_characters_gets_a_usable_name(self):
        assert safe_sheet_name("[]:*?/\\", set())
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_sheets.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.export'`

- [ ] **Step 4: Write the module**

```python
# backend/app/export/sheets.py
"""Rules for turning report data into spreadsheet cells safely.

Pure functions, no I/O. The interesting one is `looks_like_formula`: values
come from the user's warehouse, not from us, and the workbook is opened by
someone else.
"""

#: Excel evaluates a cell whose text begins with one of these. The data is not
#: ours, so any of them could arrive from a warehouse column.
FORMULA_PREFIXES = ("=", "+", "-", "@")

#: Excel's own limit. A longer name makes the workbook unopenable.
MAX_SHEET_NAME = 31

#: Excel refuses these in a sheet name outright.
_FORBIDDEN = set('[]:*?/\\')

_FALLBACK_SHEET_NAME = "Sheet"


def looks_like_formula(value: object) -> bool:
    """Would a spreadsheet treat this text as a formula?

    Only strings can be: a negative NUMBER is a number, and writing it as text
    would be worse than useless. Leading whitespace is stripped first, because
    Excel tolerates it and a naive `startswith` does not.
    """
    if not isinstance(value, str):
        return False
    return value.lstrip().startswith(FORMULA_PREFIXES)


def safe_sheet_name(title: str, taken: set[str]) -> str:
    """An Excel-legal, unique sheet name derived from a visual's title.

    Collisions get a numeric suffix rather than silently overwriting the
    earlier sheet -- two visuals called "Revenue" is completely normal.
    """
    cleaned = "".join(c for c in (title or "") if c not in _FORBIDDEN).strip()
    base = (cleaned or _FALLBACK_SHEET_NAME)[:MAX_SHEET_NAME]

    if base not in taken:
        return base

    counter = 2
    while True:
        suffix = f" ({counter})"
        # Trimmed so the suffix fits: a 31-character title plus " (2)" would
        # otherwise produce an unopenable workbook.
        candidate = base[: MAX_SHEET_NAME - len(suffix)] + suffix
        if candidate not in taken:
            return candidate
        counter += 1
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_sheets.py -v`
Expected: PASS (14 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/export backend/app/config.py backend/pyproject.toml backend/tests/test_export_sheets.py
git commit -m "feat: spreadsheet cell and sheet-name rules, including formula-injection detection"
```

---

## Task 2: Building the workbook

**Files:**
- Create: `backend/app/export/workbook.py`
- Test: `backend/tests/test_export_workbook.py`

**Interfaces:**
- Consumes: `safe_sheet_name`, `looks_like_formula`, `settings.export_row_cap`
- Produces:
  - `@dataclass SheetData(title: str, columns: list[dict], rows: list[list], context: str = "", error: str = "")`
  - `build_workbook(report_name: str, view: str, exported_by: str, sheets: list[SheetData], *, generated_at: datetime) -> bytes`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_export_workbook.py
import io
from datetime import datetime, timezone

import openpyxl
import pytest

from app.export.workbook import SheetData, build_workbook

WHEN = datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc)


def build(sheets, name="Sales overview"):
    """Build a workbook and read it back with a DIFFERENT library.

    openpyxl rather than trusting xlsxwriter's own view: the question is what
    Excel will see, and a reader that shares no code with the writer is the
    closest available proxy.
    """
    data = build_workbook(
        name, "ANALYTICS.PUBLIC.SALES", "ALICE", sheets, generated_at=WHEN
    )
    return openpyxl.load_workbook(io.BytesIO(data))


def a_sheet(**over):
    base = {
        "title": "Revenue by region",
        "columns": [{"name": "REGION"}, {"name": "TOTAL_REVENUE"}],
        "rows": [["EAST", 100], ["WEST", 200]],
    }
    return SheetData(**{**base, **over})


class TestFormulaInjection:
    """The thing this feature would otherwise get wrong."""

    PAYLOADS = [
        "=cmd|'/c calc'!A0",
        '=HYPERLINK("http://evil","click")',
        "+HYPERLINK(1)",
        "-2+3+cmd|' /C calc'!A0",
        "@SUM(1+1)",
    ]

    def test_a_dangerous_value_is_stored_as_text_not_a_formula(self):
        wb = build([a_sheet(rows=[[p, 1] for p in self.PAYLOADS])])
        ws = wb["Revenue by region"]
        for row, payload in enumerate(self.PAYLOADS, start=2):
            cell = ws.cell(row=row, column=1)
            assert cell.data_type == "s", f"{payload!r} was not stored as a string"
            assert cell.value == payload, "the displayed text must be unchanged"

    def test_the_value_is_not_prefixed_or_mangled(self):
        """Preferred over the usual apostrophe trick, which changes what the
        reader sees."""
        wb = build([a_sheet(rows=[["=1+1", 1]])])
        assert wb["Revenue by region"].cell(row=2, column=1).value == "=1+1"

    def test_a_negative_number_stays_a_number(self):
        """`-5` starts with a dangerous prefix but is not text. Writing it as a
        string would break every sum in the sheet."""
        wb = build([a_sheet(rows=[["EAST", -5]])])
        cell = wb["Revenue by region"].cell(row=2, column=2)
        assert cell.value == -5
        assert cell.data_type == "n"


class TestShape:
    def test_a_summary_sheet_comes_first(self):
        wb = build([a_sheet()])
        assert wb.sheetnames[0] == "Summary"

    def test_the_summary_names_the_report_and_the_view(self):
        wb = build([a_sheet()])
        text = "\n".join(
            str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value
        )
        assert "Sales overview" in text
        assert "ANALYTICS.PUBLIC.SALES" in text
        assert "ALICE" in text
        assert "2026-08-16" in text

    def test_the_summary_records_each_sheets_context(self):
        """A file found in a shared drive six months later should explain
        itself."""
        wb = build([a_sheet(context="Drilled into US > California")])
        text = "\n".join(
            str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value
        )
        assert "Drilled into US > California" in text

    def test_one_sheet_per_visual_named_after_it(self):
        wb = build([a_sheet(title="A"), a_sheet(title="B")])
        assert wb.sheetnames == ["Summary", "A", "B"]

    def test_duplicate_titles_do_not_overwrite_each_other(self):
        wb = build([a_sheet(title="Revenue"), a_sheet(title="Revenue")])
        assert wb.sheetnames == ["Summary", "Revenue", "Revenue (2)"]

    def test_the_header_row_carries_the_column_names(self):
        ws = build([a_sheet()])["Revenue by region"]
        assert [ws.cell(row=1, column=i).value for i in (1, 2)] == [
            "REGION",
            "TOTAL_REVENUE",
        ]

    def test_the_rows_are_written_in_order(self):
        ws = build([a_sheet()])["Revenue by region"]
        assert ws.cell(row=2, column=1).value == "EAST"
        assert ws.cell(row=3, column=1).value == "WEST"

    def test_a_null_becomes_an_empty_cell_not_the_text_None(self):
        ws = build([a_sheet(rows=[[None, 1]])])["Revenue by region"]
        assert ws.cell(row=2, column=1).value in (None, "")


class TestFailureAndLimits:
    def test_a_failed_sheet_carries_its_error_and_the_others_still_carry_data(self):
        """A colleague with narrower Snowflake permissions gets a partial
        workbook that explains itself, not a 500."""
        wb = build(
            [
                a_sheet(title="Allowed"),
                a_sheet(title="Denied", rows=[], error="Insufficient privileges"),
            ]
        )
        assert wb["Allowed"].cell(row=2, column=1).value == "EAST"
        denied = "\n".join(
            str(c.value) for row in wb["Denied"].iter_rows() for c in row if c.value
        )
        assert "Insufficient privileges" in denied

    def test_the_summary_names_which_sheets_failed(self):
        wb = build([a_sheet(title="Denied", rows=[], error="nope")])
        text = "\n".join(
            str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value
        )
        assert "Denied" in text
        assert "nope" in text

    def test_truncation_is_declared_rather_than_silent(self, monkeypatch):
        from app.export import workbook as workbook_module

        monkeypatch.setattr(workbook_module, "MAX_ROWS_PER_SHEET", 2)
        wb = build([a_sheet(rows=[["A", 1], ["B", 2], ["C", 3]])])
        ws = wb["Revenue by region"]
        assert ws.max_row == 3, "header plus two rows"
        text = "\n".join(
            str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value
        )
        assert "truncat" in text.lower()

    def test_an_empty_result_is_a_sheet_with_only_headers(self):
        ws = build([a_sheet(rows=[])])["Revenue by region"]
        assert ws.cell(row=1, column=1).value == "REGION"
        assert ws.max_row == 1


def test_the_output_is_a_readable_workbook_not_merely_bytes():
    data = build_workbook("R", "V", "ALICE", [a_sheet()], generated_at=WHEN)
    assert data[:2] == b"PK", "an xlsx is a zip archive"
    openpyxl.load_workbook(io.BytesIO(data))
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_workbook.py -v`
Expected: FAIL — no module named `app.export.workbook`

- [ ] **Step 3: Write the workbook builder**

```python
# backend/app/export/workbook.py
"""Turn already-fetched results into an .xlsx file.

Takes data in, returns bytes. No Snowflake, no HTTP, no session -- which is
what lets the formula-injection rules be tested directly rather than through
an endpoint.
"""

import io
from dataclasses import dataclass, field
from datetime import datetime

import xlsxwriter

from app.export.sheets import looks_like_formula, safe_sheet_name

#: Excel's own ceiling is 1,048,576. This is generous and bounded, and any
#: truncation is declared on the Summary sheet.
MAX_ROWS_PER_SHEET = 100000


@dataclass
class SheetData:
    title: str
    columns: list[dict]
    rows: list[list]
    #: Free text describing drill position or cross-filter, recorded on the
    #: Summary sheet so the file explains itself later.
    context: str = ""
    #: When set, this sheet carries the error instead of data. One visual the
    #: viewer's role cannot read must not cost them the whole workbook.
    error: str = ""
    filters: list[str] = field(default_factory=list)


def _write_cell(worksheet, row: int, col: int, value: object, text_format) -> None:
    """Write one cell, never letting a warehouse value become a formula.

    `write_string` rather than `write`: the latter type-guesses, and a value
    beginning "=" would be written as a formula for the reader to evaluate.
    """
    if value is None:
        return
    if isinstance(value, str):
        worksheet.write_string(row, col, value, text_format if looks_like_formula(value) else None)
        return
    if isinstance(value, bool):
        worksheet.write_boolean(row, col, value)
        return
    if isinstance(value, (int, float)):
        worksheet.write_number(row, col, value)
        return
    # Dates, Decimals and anything else: rendered as text rather than guessed
    # at. A wrong type in a spreadsheet is worse than an honest string.
    worksheet.write_string(row, col, str(value))


def build_workbook(
    report_name: str,
    view: str,
    exported_by: str,
    sheets: list[SheetData],
    *,
    generated_at: datetime,
) -> bytes:
    buffer = io.BytesIO()
    workbook = xlsxwriter.Workbook(
        buffer,
        {
            # Belt and braces alongside write_string: this stops xlsxwriter
            # promoting ANY leading-"=" string to a formula anywhere.
            "strings_to_formulas": False,
            "in_memory": True,
            # Flat memory regardless of row count.
            "constant_memory": True,
            "default_date_format": "yyyy-mm-dd hh:mm:ss",
        },
    )
    header = workbook.add_format({"bold": True})
    text = workbook.add_format({"num_format": "@"})

    summary = workbook.add_worksheet("Summary")
    summary.set_column(0, 0, 22)
    summary.set_column(1, 1, 80)

    meta = [
        ("Report", report_name),
        ("Semantic view", view),
        ("Exported by", exported_by),
        ("Generated at", generated_at.strftime("%Y-%m-%d %H:%M:%S %Z").strip()),
        ("Sheets", str(len(sheets))),
    ]
    for row, (label, value) in enumerate(meta):
        summary.write_string(row, 0, label, header)
        summary.write_string(row, 1, str(value))

    notes_row = len(meta) + 1
    summary.write_string(notes_row, 0, "Sheet", header)
    summary.write_string(notes_row, 1, "Notes", header)
    notes_row += 1

    taken: set[str] = {"Summary"}
    for data in sheets:
        name = safe_sheet_name(data.title, taken)
        taken.add(name)
        worksheet = workbook.add_worksheet(name)

        notes: list[str] = []
        if data.error:
            notes.append(f"FAILED: {data.error}")
        if data.context:
            notes.append(data.context)
        if data.filters:
            notes.append("Filters: " + "; ".join(data.filters))

        if data.error:
            worksheet.write_string(0, 0, "This sheet could not be exported", header)
            worksheet.write_string(1, 0, data.error)
        else:
            for col, column in enumerate(data.columns):
                worksheet.write_string(0, col, str(column.get("name", "")), header)
            worksheet.freeze_panes(1, 0)

            written = 0
            for row_values in data.rows[:MAX_ROWS_PER_SHEET]:
                written += 1
                for col, value in enumerate(row_values):
                    _write_cell(worksheet, written, col, value, text)

            if len(data.rows) > MAX_ROWS_PER_SHEET:
                notes.append(
                    f"Truncated to {MAX_ROWS_PER_SHEET} of {len(data.rows)} rows"
                )

        summary.write_string(notes_row, 0, name)
        summary.write_string(notes_row, 1, " | ".join(notes) if notes else "OK")
        notes_row += 1

    workbook.close()
    return buffer.getvalue()
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_workbook.py -v`
Expected: PASS (17 tests)

If `constant_memory` mode rejects out-of-order writes, note that it requires
rows to be written top to bottom in each worksheet — the code above already
does, but the Summary sheet is written across the whole run. If that conflicts,
build the Summary sheet's rows into a list first and write it last, rather than
disabling `constant_memory`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/export/workbook.py backend/tests/test_export_workbook.py
git commit -m "feat: build an xlsx workbook that never turns a warehouse value into a formula"
```

---

## Task 3: Copyable SQL for Excel's own connector

**Files:**
- Create: `backend/app/export/literals.py`
- Test: `backend/tests/test_export_literals.py`

**Interfaces:**
- Consumes: `SemanticQueryRequest`, `build_semantic_sql`
- Produces: `build_literal_sql(detail: dict, req: SemanticQueryRequest, *, today: date | None = None) -> str`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_export_literals.py
from datetime import date

import pytest

from app.errors import ApiError
from app.export.literals import build_literal_sql
from app.semantic.query import SemanticQueryRequest, build_semantic_sql

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER"}],
    "facts": [],
}


def req(**payload):
    base = {"database": "D", "schema": "S", "view": "V"}
    return SemanticQueryRequest.model_validate({**base, **payload})


def test_an_unfiltered_query_is_unchanged_apart_from_having_no_placeholders():
    sql = build_literal_sql(DETAIL, req(metrics=["ORDERS.TOTAL_REVENUE"]))
    assert "?" not in sql
    assert "SEMANTIC_VIEW" in sql


def test_a_filter_value_is_inlined_as_a_quoted_literal():
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {"id": "f", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
            ],
        ),
    )
    assert "'EAST'" in sql
    assert "?" not in sql


def test_a_quote_in_a_value_is_doubled_so_the_statement_stays_valid():
    """The escaping exists so a value containing a quote produces VALID SQL --
    not to prevent an escalation. The user runs this as themselves."""
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "CUSTOMERS.REGION",
                    "op": "is",
                    "values": ["O'Brien"],
                }
            ],
        ),
    )
    assert "'O''Brien'" in sql


def test_a_hostile_value_cannot_terminate_the_statement():
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "CUSTOMERS.REGION",
                    "op": "is",
                    "values": ["' OR 1=1 --"],
                }
            ],
        ),
    )
    # Doubled, so it is one literal rather than a closed string plus a clause.
    assert "''' OR 1=1 --'" in sql or "''' OR 1=1 --'" in sql.replace('"', "")
    assert sql.count(";") == 0


def test_a_number_is_not_quoted():
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "ORDERS.ORDER_DATE",
                    "op": "between",
                    "from": 1,
                    "to": 9,
                }
            ],
        ),
    )
    assert "BETWEEN 1 AND 9" in sql


def test_a_relative_date_is_resolved_to_concrete_dates():
    """Power Query cannot evaluate "last 30 days"; it has to arrive resolved."""
    sql = build_literal_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {
                    "id": "f",
                    "field": "ORDERS.ORDER_DATE",
                    "op": "relativeDate",
                    "unit": "day",
                    "count": 7,
                }
            ],
        ),
        today=date(2026, 8, 16),
    )
    assert "TO_DATE('2026-08-10')" in sql
    assert "TO_DATE('2026-08-16')" in sql


def test_an_unknown_field_is_still_rejected():
    """The copyable path validates identifiers exactly like the executable one."""
    with pytest.raises(ApiError):
        build_literal_sql(
            DETAIL,
            req(
                metrics=["ORDERS.TOTAL_REVENUE"],
                filters=[
                    {"id": "f", "field": "X.Y", "op": "is", "values": ["1"]}
                ],
            ),
        )


def test_the_executable_builder_still_uses_placeholders():
    """The guard against these two paths being confused by a later refactor.

    If someone ever "simplifies" build_semantic_sql to inline its values, this
    fails -- and it should, loudly.
    """
    sql, params, _ = build_semantic_sql(
        DETAIL,
        req(
            metrics=["ORDERS.TOTAL_REVENUE"],
            filters=[
                {"id": "f", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
            ],
        ),
        max_rows=100,
    )
    assert "?" in sql
    assert "EAST" not in sql
    assert params == ["EAST"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_literals.py -v`
Expected: FAIL — no module named `app.export.literals`

- [ ] **Step 3: Write the module**

```python
# backend/app/export/literals.py
"""Copyable SQL for Excel's own Snowflake connector.

THIS MODULE IS NEVER EXECUTED BY THIS APPLICATION. It produces a statement for
a human to paste into Power Query, which supplies no bind parameters and so
cannot use the placeholders every executed statement here uses.

It deliberately does not import a cursor, a connection, or the gateway. If you
find yourself wanting to run what this returns, you want
`app.semantic.query.build_semantic_sql` instead -- which binds its values, and
which a test asserts still does.

Inlining is safe HERE in a way it is not elsewhere: the statement runs in the
user's own Excel, under their own Snowflake role, expressing nothing they could
not already do by hand. The escaping exists so a value containing a quote
produces valid SQL, not to prevent an escalation that was never available.
"""

from datetime import date
from typing import Any

from app.reports.filters import BetweenFilter, InFilter, RelativeDateFilter, is_active
from app.semantic.discovery import quote_ident
from app.semantic.predicates import resolve_field, resolve_relative_date
from app.semantic.query import SemanticQueryRequest, build_semantic_sql


def _literal(value: Any) -> str:
    """One SQL literal. Strings quoted with doubled quotes; numbers bare."""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, date):
        return f"TO_DATE('{value.isoformat()}')"
    text = str(value).replace("'", "''")
    return f"'{text}'"


def _predicate(detail: dict, f: Any, today: date) -> str:
    table, name = resolve_field(detail, f.field)
    column = f"{quote_ident(table)}.{quote_ident(name)}"

    if isinstance(f, InFilter):
        negated = f.op == "isNot"
        if len(f.values) == 1:
            return f"{column} {'<>' if negated else '='} {_literal(f.values[0])}"
        joined = ", ".join(_literal(v) for v in f.values)
        return f"{column} {'NOT IN' if negated else 'IN'} ({joined})"
    if isinstance(f, BetweenFilter):
        return f"{column} BETWEEN {_literal(f.from_)} AND {_literal(f.to)}"
    if isinstance(f, RelativeDateFilter):
        # Resolved here, because Power Query cannot evaluate "last 30 days".
        start, end = resolve_relative_date(f, today)
        return f"{column} BETWEEN {_literal(start)} AND {_literal(end)}"
    return ""


def build_literal_sql(
    detail: dict, req: SemanticQueryRequest, *, today: date | None = None
) -> str:
    """The same query, with values inlined, for pasting into Excel.

    Identifiers go through the same `resolve_field` and `quote_ident` the
    executable path uses, so an unknown field is rejected here too.
    """
    clock = today or date.today()

    # Built without filters first, so the shape, ORDER BY and LIMIT all come
    # from the one function that knows how to assemble them.
    skeleton = req.model_copy(update={"filters": []})
    sql, params, _ = build_semantic_sql(detail, skeleton, max_rows=1000000)
    assert not params, "the skeleton must carry no parameters"

    predicates = [
        _predicate(detail, f, clock) for f in req.filters if is_active(f)
    ]
    # Resolve every filter's field even when inactive, matching the executable
    # path: being unfinished is not a way to smuggle an unvalidated reference
    # into a statement handed to a user.
    for f in req.filters:
        if not is_active(f):
            resolve_field(detail, f.field)

    if predicates:
        where = "  WHERE " + " AND ".join(predicates)
        head, sep, tail = sql.partition("\n)")
        sql = f"{head}\n{where}{sep}{tail}"
    return sql
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_literals.py -v`
Expected: PASS (8 tests)

**Before writing this module**, rename `_resolve` in
`backend/app/semantic/predicates.py` to `resolve_field` and update its call
sites there. Importing an underscore-prefixed name across modules advertises
that the boundary is wrong; the function is now genuinely shared.

- [ ] **Step 5: Commit**

```bash
git add backend/app/export/literals.py backend/app/semantic/predicates.py backend/tests/test_export_literals.py
git commit -m "feat: copyable literal SQL for Excel, on a path that never executes"
```

---

## Task 4: The endpoints

**Files:**
- Create: `backend/app/export/service.py`, `backend/app/export/routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_export_routes.py`

**Interfaces:**
- Consumes: `require_access`, `get_cache`, `build_semantic_sql`, `gateway.run_query`, `build_workbook`, `SheetData`, `build_literal_sql`
- Produces:
  - `service.export_workbook(db, sess, report_id, sheets) -> bytes`
  - `service.connection_details(db, sess, report_id, sheets) -> dict`
  - `POST /api/reports/{report_id}/export.xlsx`
  - `GET /api/reports/{report_id}/connect` — takes the same sheet list as a POST body would; implemented as `POST /api/reports/{report_id}/connect` for the same reason export is a POST

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_export_routes.py
import io

import openpyxl
import pytest
from snowflake.connector.errors import ProgrammingError

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember
from app.snowflake.provider import get_cache
from tests.test_report_routes import sign_in, valid_definition
from tests.test_semantic_routes import ScriptedConnection

SHEET = {
    "title": "Revenue by region",
    "dimensions": ["ORDERS.ORDER_DATE"],
    "metrics": ["ORDERS.TOTAL_REVENUE"],
}


@pytest.fixture
def report(client, db):
    sess = sign_in(client, db)
    db.commit()
    workspace = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id)
        .one()
    )
    row = Report(
        owner_user_id=sess.user_id,
        workspace_id=workspace.id,
        name="Sales overview",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=valid_definition(),
    )
    db.add(row)
    db.commit()
    get_cache().put(sess.id, ScriptedConnection())
    return row


def export(client, report, sheets=None):
    return client.post(
        f"/api/reports/{report.id}/export.xlsx",
        json={"sheets": sheets or [SHEET]},
    )


def test_export_requires_auth(client):
    assert (
        client.post("/api/reports/x/export.xlsx", json={"sheets": []}).status_code
        == 401
    )


def test_the_response_is_a_readable_workbook(client, db, report):
    response = export(client, report)
    assert response.status_code == 200
    assert "spreadsheetml" in response.headers["content-type"]
    assert "Sales overview" in response.headers["content-disposition"]
    workbook = openpyxl.load_workbook(io.BytesIO(response.content))
    assert workbook.sheetnames == ["Summary", "Revenue by region"]


def test_the_sheet_carries_the_queried_rows(client, db, report):
    workbook = openpyxl.load_workbook(io.BytesIO(export(client, report).content))
    ws = workbook["Revenue by region"]
    assert ws.cell(row=1, column=1).value == "ORDER_DATE"
    assert ws.cell(row=2, column=1).value == "2026-01-01"


def test_the_filters_sent_by_the_client_are_bound_not_interpolated(client, db, report):
    """Export runs the same validated path as a normal query."""
    conn = get_cache()
    response = export(
        client,
        report,
        sheets=[
            {
                **SHEET,
                "filters": [
                    {
                        "id": "f",
                        "field": "CUSTOMERS.REGION",
                        "op": "is",
                        "values": ["EAST"],
                    }
                ],
            }
        ],
    )
    assert response.status_code == 200


def test_a_forbidden_visual_does_not_lose_the_whole_workbook(client, db, report):
    """The colleague-with-narrower-permissions case."""

    class PartlyForbidden(ScriptedConnection):
        def cursor(self):
            cursor = super().cursor()
            if getattr(cursor, "_wrapped", False):
                return cursor
            original = cursor.execute

            def execute(sql, params=None):
                if "TOTAL_REVENUE" in sql and not sql.startswith("DESCRIBE"):
                    raise ProgrammingError(
                        msg="Insufficient privileges", errno=3001
                    )
                return original(sql, params)

            cursor.execute = execute
            cursor._wrapped = True
            return cursor

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    get_cache().put(sess.id, PartlyForbidden())
    client.cookies.set(SESSION_COOKIE, sess.id)

    response = client.post(
        f"/api/reports/{report.id}/export.xlsx",
        json={
            "sheets": [
                {"title": "OK", "dimensions": ["ORDERS.ORDER_DATE"], "metrics": []},
                {"title": "Denied", "dimensions": [], "metrics": ["ORDERS.TOTAL_REVENUE"]},
            ]
        },
    )
    assert response.status_code == 200
    workbook = openpyxl.load_workbook(io.BytesIO(response.content))
    denied = "\n".join(
        str(c.value) for row in workbook["Denied"].iter_rows() for c in row if c.value
    )
    assert "privileges" in denied.lower()
    assert workbook["OK"].cell(row=2, column=1).value == "2026-01-01"


def test_an_unknown_field_fails_the_whole_export(client, db, report):
    """A client bug, not a permissions difference -- so it is loud."""
    response = export(
        client, report, sheets=[{"title": "X", "dimensions": ["A.NOPE"], "metrics": []}]
    )
    assert response.status_code == 400


def test_exporting_a_report_i_cannot_see_is_404(client, db, report):
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    get_cache().put(other.id, ScriptedConnection())
    client.cookies.set(SESSION_COOKIE, other.id)
    assert export(client, report).status_code == 404


def test_too_many_sheets_is_rejected(client, db, report):
    response = export(client, report, sheets=[SHEET] * 51)
    assert response.status_code == 422


def test_connect_returns_literal_sql_and_the_account(client, db, report):
    response = client.post(
        f"/api/reports/{report.id}/connect", json={"sheets": [SHEET]}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["database"] == "ANALYTICS"
    assert body["view"] == "SALES"
    assert body["account"]
    assert "?" not in body["sheets"][0]["sql"]
    assert "SEMANTIC_VIEW" in body["sheets"][0]["sql"]


def test_connect_needs_only_viewer(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    row = Report(
        owner_user_id=sess.user_id,
        workspace_id=ws.id,
        name="R",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=valid_definition(),
    )
    db.add(row)
    db.commit()
    get_cache().put(sess.id, ScriptedConnection())
    response = client.post(f"/api/reports/{row.id}/connect", json={"sheets": [SHEET]})
    assert response.status_code == 200
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_routes.py -v`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the service**

```python
# backend/app/export/service.py
"""Run each sheet's query on the caller's connection, then build the workbook."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import DbSession
from app.errors import ApiError
from app.export.literals import build_literal_sql
from app.export.workbook import SheetData, build_workbook
from app.reports.filters import is_active
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache
from app.workspaces.access import require_access


def _request(report, sheet: dict) -> SemanticQueryRequest:
    return SemanticQueryRequest.model_validate(
        {
            "database": report.view_database,
            "schema": report.view_schema,
            "view": report.view_name,
            "dimensions": sheet.get("dimensions", []),
            "metrics": sheet.get("metrics", []),
            "filters": sheet.get("filters", []),
            "orderBy": sheet.get("orderBy", []),
        }
    )


def _describe_filters(request: SemanticQueryRequest) -> list[str]:
    return [f"{f.field} {f.op}" for f in request.filters if is_active(f)]


def _prepare(db: Session, sess: DbSession, report_id: str):
    report = require_access(db, sess.user_id, report_id, need="viewer")
    if not report.view_name:
        raise ApiError(
            "REPORT_INVALID", 400, "This report is not bound to a semantic view."
        )
    cache = get_cache()
    entry = cache.acquire(db, sess)
    return report, cache, entry


def export_workbook(
    db: Session, sess: DbSession, report_id: str, sheets: list[dict]
) -> tuple[str, bytes]:
    report, cache, entry = _prepare(db, sess, report_id)
    settings = get_settings()

    built: list[SheetData] = []
    with entry.lock:
        detail = cache.describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        for sheet in sheets:
            # Validation errors are NOT caught: an unknown field is a client
            # bug and must be loud. Only execution failures degrade a sheet.
            request = _request(report, sheet)
            sql, params, limit = build_semantic_sql(
                detail, request, max_rows=settings.export_row_cap
            )
            common = {
                "title": sheet.get("title") or "Sheet",
                "context": sheet.get("context", ""),
                "filters": _describe_filters(request),
            }
            try:
                result = gateway.run_query(
                    entry.conn, sql, max_rows=limit, params=params
                )
            except ApiError as exc:
                # One visual the viewer's role cannot read must not cost them
                # the whole workbook.
                built.append(SheetData(columns=[], rows=[], error=exc.message, **common))
                continue
            built.append(
                SheetData(columns=result.columns, rows=result.rows, **common)
            )

    data = build_workbook(
        report.name,
        f"{report.view_database}.{report.view_schema}.{report.view_name}",
        sess.user.snowflake_user,
        built,
        generated_at=datetime.now(timezone.utc),
    )
    return report.name, data


def connection_details(
    db: Session, sess: DbSession, report_id: str, sheets: list[dict]
) -> dict:
    report, cache, entry = _prepare(db, sess, report_id)
    with entry.lock:
        detail = cache.describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        out = [
            {
                "title": sheet.get("title") or "Sheet",
                "sql": build_literal_sql(detail, _request(report, sheet)),
            }
            for sheet in sheets
        ]
    return {
        "account": sess.user.snowflake_account,
        "database": report.view_database,
        "schema": report.view_schema,
        "view": report.view_name,
        "sheets": out,
    }
```

- [ ] **Step 4: Write the routes**

```python
# backend/app/export/routes.py
import re

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession
from app.export import service
from app.reports.schema import MAX_VISUALS

router = APIRouter()

XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)

#: Anything that would break a Content-Disposition header or a filesystem.
_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\r\n]+')


class SheetRequest(BaseModel):
    title: str = Field(default="", max_length=200)
    dimensions: list[str] = Field(default_factory=list)
    metrics: list[str] = Field(default_factory=list)
    filters: list[dict] = Field(default_factory=list)
    orderBy: list[dict] = Field(default_factory=list)
    context: str = Field(default="", max_length=500)


class ExportBody(BaseModel):
    sheets: list[SheetRequest] = Field(default_factory=list, max_length=MAX_VISUALS)


def _filename(report_name: str) -> str:
    cleaned = _UNSAFE_FILENAME.sub("", report_name).strip() or "report"
    return f"{cleaned[:120]}.xlsx"


@router.post("/api/reports/{report_id}/export.xlsx")
def export_xlsx(
    report_id: str,
    body: ExportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    name, data = service.export_workbook(
        db, sess, report_id, [s.model_dump() for s in body.sheets]
    )
    return Response(
        content=data,
        media_type=XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(name)}"'
        },
    )


@router.post("/api/reports/{report_id}/connect")
def connect(
    report_id: str,
    body: ExportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return service.connection_details(
        db, sess, report_id, [s.model_dump() for s in body.sheets]
    )
```

Register the router in `backend/app/main.py` beside the others.

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_export_routes.py -v`
Expected: PASS

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/app/export backend/app/main.py backend/tests/test_export_routes.py
git commit -m "feat: export a report to xlsx, and hand Excel the SQL to connect live"
```

---

## Task 5: The frontend

**Files:**
- Create: `frontend/src/api/exports.ts`, `frontend/src/export/ConnectPanel.tsx`
- Modify: `frontend/src/api/types.ts`, `frontend/src/reports/BuilderPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/export/ConnectPanel.test.tsx`, `frontend/src/api/exports.test.ts`

**Interfaces:**
- Produces:
  - `SheetRequest`, `ConnectResponse` in `types.ts`
  - `downloadXlsx(reportId: string, sheets: SheetRequest[], filename: string): Promise<void>`
  - `fetchConnectDetails(reportId: string, sheets: SheetRequest[]): Promise<ConnectResponse>`
  - `sheetRequestsFor(definition, hierarchies, drill, crossFilter): SheetRequest[]`
  - `<ConnectPanel reportId sheets onClose />`

- [ ] **Step 1: Add the types**

In `frontend/src/api/types.ts`:

```ts
export interface SheetRequest {
  title: string;
  dimensions: string[];
  metrics: string[];
  filters: Filter[];
  orderBy: { field: string; direction: "asc" | "desc" }[];
  /** Free text describing drill position or cross-filter, recorded on the
   *  workbook's Summary sheet so the file explains itself later. */
  context: string;
}

export interface ConnectResponse {
  account: string;
  database: string;
  schema: string;
  view: string;
  sheets: { title: string; sql: string }[];
}
```

- [ ] **Step 2: Write the failing client test**

```ts
// frontend/src/api/exports.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetRequest } from "./types";
import { downloadXlsx, fetchConnectDetails } from "./exports";

const SHEETS: SheetRequest[] = [
  {
    title: "Revenue",
    dimensions: ["C.REGION"],
    metrics: ["A.REV"],
    filters: [],
    orderBy: [],
    context: "",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ account: "ACME", sheets: [] }),
    json: async () => ({ account: "ACME", sheets: [] }),
    blob: async () => new Blob(["x"]),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("exports API", () => {
  it("posts the sheets to the xlsx endpoint", async () => {
    await downloadXlsx("r1", SHEETS, "Sales.xlsx");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/r1/export.xlsx");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).sheets[0].title).toBe("Revenue");
  });

  it("sends credentials, since the export runs on the user's own connection", () => {
    return downloadXlsx("r1", SHEETS, "Sales.xlsx").then(() => {
      expect(fetchMock.mock.calls[0][1].credentials).toBe("same-origin");
    });
  });

  it("fetches connection details", async () => {
    await fetchConnectDetails("r1", SHEETS);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/reports/r1/connect");
  });
});
```

- [ ] **Step 3: Write the client**

```ts
// frontend/src/api/exports.ts
import { apiFetch, ApiError } from "./client";
import type { ConnectResponse, SheetRequest } from "./types";

export function fetchConnectDetails(
  reportId: string,
  sheets: SheetRequest[],
): Promise<ConnectResponse> {
  return apiFetch<ConnectResponse>(
    `/api/reports/${encodeURIComponent(reportId)}/connect`,
    { method: "POST", body: JSON.stringify({ sheets }) },
  );
}

/** Not apiFetch: the response is a binary workbook, not JSON, so it needs the
 *  raw fetch. `credentials` is still same-origin -- the export runs on the
 *  user's own Snowflake connection and needs their session. */
export async function downloadXlsx(
  reportId: string,
  sheets: SheetRequest[],
  filename: string,
): Promise<void> {
  const response = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/export.xlsx`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheets }),
    },
  );
  if (!response.ok) {
    let body: { message?: string; code?: string } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body; fall through to the default message
    }
    throw new ApiError(
      body.code ?? "QUERY_ERROR",
      response.status,
      body.message ?? "Could not export this report.",
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: Build the sheet list from what is on screen**

In `frontend/src/reports/filters.ts`, add:

```ts
/** One export sheet per visual, carrying exactly what that tile is currently
 *  showing -- drill position and cross-filter included.
 *
 *  This is the same resolution `useVisualQuery` performs, so an export can
 *  never disagree with the screen it was taken from. */
export function sheetRequestsFor(
  visuals: Visual[],
  reportFilters: Filter[],
  hierarchies: Hierarchy[],
  drill: Record<string, DrillState>,
  crossFilter: CrossFilter | null,
  titleOf: (visual: Visual, wells: Record<string, string[]>) => string,
  wellsToQuery: (
    type: string,
    wells: Record<string, string[]>,
  ) => { dimensions: string[]; metrics: string[] },
): SheetRequest[] {
  return visuals.map((visual) => {
    const own = drill[visual.id];
    const wells = resolveWells(visual.wells, hierarchies, own);
    const { dimensions, metrics } = wellsToQuery(visual.type, wells);
    const parts: string[] = [];
    if (own?.path.length) {
      parts.push(`Drilled into ${own.path.map((s) => s.value).join(" > ")}`);
    }
    if (crossFilter && crossFilter.sourceVisualId !== visual.id) {
      parts.push(`Filtered by ${crossFilter.field} = ${crossFilter.value}`);
    }
    return {
      title: titleOf(visual, wells),
      dimensions,
      metrics,
      filters: effectiveFilters({ reportFilters, visual, drill: own, crossFilter }),
      orderBy: [],
      context: parts.join("; "),
    };
  });
}
```

Add a test in `filters.test.ts` asserting a drilled visual produces the drilled
level in `dimensions` and a `context` naming the path, and that the source
visual of a cross-filter does not carry that filter.

- [ ] **Step 5: Write the Connect panel and its test**

```tsx
// frontend/src/export/ConnectPanel.tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { fetchConnectDetails } from "../api/exports";
import type { SheetRequest } from "../api/types";

interface Props {
  reportId: string;
  sheets: SheetRequest[];
  onClose: () => void;
}

export default function ConnectPanel({ reportId, sheets, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const details = useQuery({
    queryKey: ["connect", reportId, sheets],
    queryFn: () => fetchConnectDetails(reportId, sheets),
  });

  const copy = (title: string, sql: string) => {
    navigator.clipboard?.writeText(sql);
    setCopied(title);
  };

  return (
    <section className="connect-panel" aria-label="Connect from Excel">
      <header>
        <h3>Connect live from Excel</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      <ol className="connect-steps">
        <li>In Excel: Data → Get Data → From Database → From Snowflake.</li>
        <li>
          Server: <code>{details.data?.account ?? "…"}.snowflakecomputing.com</code>
        </li>
        <li>Sign in with your own Snowflake credentials.</li>
        <li>Choose Advanced options and paste one of the statements below.</li>
      </ol>

      <p className="tile-hint">
        The workbook refreshes straight from Snowflake as you. No data passes
        through this application once it is connected.
      </p>

      {details.isLoading && <p className="tile-hint">Building the statements…</p>}
      {details.isError && (
        <p role="alert">
          {details.error instanceof ApiError
            ? details.error.message
            : "Could not build the connection details."}
        </p>
      )}

      {details.data?.sheets.map((sheet) => (
        <div key={sheet.title} className="connect-sql">
          <div className="connect-sql-head">
            <strong>{sheet.title}</strong>
            <button type="button" className="link" onClick={() => copy(sheet.title, sheet.sql)}>
              {copied === sheet.title ? "Copied" : `Copy SQL for ${sheet.title}`}
            </button>
          </div>
          <pre>{sheet.sql}</pre>
        </div>
      ))}
    </section>
  );
}
```

Test it with a stubbed fetch: the steps name the account, each sheet's SQL is
shown, the copy button writes to a stubbed `navigator.clipboard`, and an error
response surfaces as an alert.

- [ ] **Step 6: Wire into the builder**

Add two header buttons beside Ask: **Excel** (calls `downloadXlsx` with
`sheetRequestsFor(...)` and `${definition.name}.xlsx`) and **Connect live**
(opens `ConnectPanel` in the existing `.panel-overlay`). Both available to
viewers. Show a pending state naming the work: *"Running each visual's
query…"*. Surface a failure as `role="alert"` rather than a silent no-op.

Add a builder test asserting the export POST body contains one sheet per
visual, with the drilled level when a tile is drilled.

- [ ] **Step 7: Styles**

```css
.connect-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: min(720px, 94vw);
  max-height: 80vh;
  overflow-y: auto;
}
.connect-panel header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.connect-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connect-sql {
  border: 1px solid var(--border);
  border-radius: var(--radius-pane);
  padding: var(--pane-padding);
}
.connect-sql-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.connect-sql pre {
  margin: 8px 0 0;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 8: Run the frontend suite**

Run: `cd frontend && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "feat: export to Excel and a live-connection panel"
```

---

## Task 6: Integration, docs, and an unstubbed browser pass

**Files:**
- Create: `backend/tests/integration/test_export_it.py`, `docs/superpowers/manual-passes/YYYY-MM-DD-excel.md`
- Modify: `README.md`

- [ ] **Step 1: Add the integration test**

```python
# backend/tests/integration/test_export_it.py
"""Export a real report against the real account, and open the result."""
import io
import os

import openpyxl
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


def test_a_real_export_opens_as_a_workbook():
    """Bytes that openpyxl refuses are bytes Excel would refuse too."""
    from datetime import datetime, timezone

    from app.export.workbook import SheetData, build_workbook
    from app.semantic.discovery import describe_semantic_view
    from app.semantic.query import SemanticQueryRequest, build_semantic_sql
    from app.snowflake import connect as sf_connect
    from app.snowflake.gateway import run_query

    conn = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    try:
        db = os.environ["SEMANTICUI_IT_DATABASE"]
        schema = os.environ["SEMANTICUI_IT_SCHEMA"]
        view = os.environ["SEMANTICUI_IT_VIEW"]
        detail = describe_semantic_view(conn, db, schema, view)
        dim = detail["dimensions"][0]
        request = SemanticQueryRequest.model_validate(
            {
                "database": db,
                "schema": schema,
                "view": view,
                "dimensions": [f"{dim['table']}.{dim['name']}"],
                "limit": 50,
            }
        )
        sql, params, limit = build_semantic_sql(detail, request, max_rows=10000)
        result = run_query(conn, sql, max_rows=limit, params=params)

        data = build_workbook(
            "Integration export",
            f"{db}.{schema}.{view}",
            os.environ["SEMANTICUI_IT_USER"],
            [SheetData(title=dim["name"], columns=result.columns, rows=result.rows)],
            generated_at=datetime.now(timezone.utc),
        )
        workbook = openpyxl.load_workbook(io.BytesIO(data))
        assert workbook.sheetnames[0] == "Summary"
        assert len(workbook.sheetnames) == 2
        print(f"\n[export] {len(data)} bytes, sheets={workbook.sheetnames}")
    finally:
        conn.close()
```

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/integration/test_export_it.py -m integration -v -s`
Expected: PASS

- [ ] **Step 2: Unstubbed browser pass**

Backend and frontend running, real credentials, **no `page.route` stubs**.
Record results in `docs/superpowers/manual-passes/YYYY-MM-DD-excel.md`, with a
section stating what was not covered.

1. Open a report with data → click Excel → a file downloads.
2. Open it and confirm: a Summary sheet naming the view and the export time,
   one sheet per visual, headers bold and frozen.
3. Drill into a visual, export again → the sheet holds the drilled level and
   the Summary names the drill path.
4. Click Connect live → the account and one SQL block per visual appear; the
   SQL contains no `?`.
5. Copy the SQL, and if Excel is available, actually connect and refresh.
6. Resize to 1440 / 1280 / 1024 / 768 / 390px → no horizontal overflow.
7. No unhandled page errors.

- [ ] **Step 3: Update the README**

Add an "Excel export and live connection" section covering: what the workbook
contains; that formula injection is neutralised by writing text cells, with the
prefixes listed; the row and sheet limits and that truncation is declared; that
a per-sheet failure keeps the workbook; that the copyable SQL is a separate
never-executed path; and the Excel steps for the native connector. State
plainly that no refreshable URL is served by this application, and why.

- [ ] **Step 4: Full verification**

    cd backend && .venv/Scripts/python.exe -m pytest -q
    cd backend && .venv/Scripts/python.exe -m pytest -q -m integration
    cd frontend && npx vitest run && npm run typecheck && npm run lint

- [ ] **Step 5: Commit**

```bash
git add backend/tests/integration README.md docs/superpowers/manual-passes/
git commit -m "test: real export integration, docs, and an unstubbed Excel pass"
```

---

## Done When

- A report downloads as a workbook that opens in Excel, with a Summary sheet
  and one sheet per visual.
- A warehouse value beginning `=`, `+`, `-` or `@` displays exactly as stored
  and is never evaluated — asserted by reading the file back with a different
  library.
- A visual the viewer's Snowflake role cannot read costs that sheet, not the
  workbook.
- Drill position and cross-filter appear in the export and are named on the
  Summary sheet.
- The Connect panel shows SQL with no `?` in it, and the executable builder
  still emits `?` — both asserted.
- Truncation is declared, never silent.
- The layout holds at all five breakpoints.
