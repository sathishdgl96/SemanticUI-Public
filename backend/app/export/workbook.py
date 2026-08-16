"""Turn already-fetched results into an .xlsx file.

Takes data in, returns bytes. No Snowflake, no HTTP, no session -- which is
what lets the formula-injection rules be tested directly rather than through an
endpoint.
"""

import io
from dataclasses import dataclass, field
from datetime import datetime

import xlsxwriter

from app.export.sheets import looks_like_formula, safe_sheet_name

#: Excel's own ceiling is 1,048,576. This is generous and bounded, and any
#: truncation is declared on the Summary sheet rather than happening silently.
MAX_ROWS_PER_SHEET = 100000


@dataclass
class SheetData:
    title: str
    columns: list[dict]
    rows: list[list]
    #: Free text describing drill position or cross-filter, recorded on the
    #: Summary sheet so the file explains itself months later.
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
    if isinstance(value, bool):
        worksheet.write_boolean(row, col, value)
        return
    if isinstance(value, (int, float)):
        worksheet.write_number(row, col, value)
        return
    if isinstance(value, str):
        worksheet.write_string(
            row, col, value, text_format if looks_like_formula(value) else None
        )
        return
    # Dates, Decimals, anything else: rendered as text rather than guessed at.
    # A wrong type in a spreadsheet is worse than an honest string.
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
            "default_date_format": "yyyy-mm-dd hh:mm:ss",
        },
    )
    header = workbook.add_format({"bold": True})
    text = workbook.add_format({"num_format": "@"})

    # Created first so it is the first tab, but written LAST: its notes column
    # can only be filled in once every data sheet has been attempted.
    summary = workbook.add_worksheet("Summary")
    summary.set_column(0, 0, 24)
    summary.set_column(1, 1, 90)

    taken: set[str] = {"Summary"}
    notes_by_sheet: list[tuple[str, str]] = []

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

        notes_by_sheet.append((name, " | ".join(notes) if notes else "OK"))

    meta = [
        ("Report", report_name),
        ("Semantic view", view),
        ("Exported by", exported_by),
        ("Generated at", generated_at.strftime("%Y-%m-%d %H:%M:%S UTC")),
        ("Sheets", str(len(sheets))),
    ]
    for row, (label, value) in enumerate(meta):
        summary.write_string(row, 0, label, header)
        summary.write_string(row, 1, str(value))

    row = len(meta) + 1
    summary.write_string(row, 0, "Sheet", header)
    summary.write_string(row, 1, "Notes", header)
    for offset, (name, note) in enumerate(notes_by_sheet, start=1):
        summary.write_string(row + offset, 0, name)
        summary.write_string(row + offset, 1, note)

    workbook.close()
    return buffer.getvalue()
