"""CSV and JSON for the feed.

CSV is what Excel's From Web turns into a table with zero clicks; JSON is
for anything programmatic, and for anyone who needs values byte-exact.

The CSV applies the same formula-injection rule as the workbook export: a
text value beginning `=`, `+`, `-` or `@` is a formula to whoever opens the
file, so it is prefixed with an apostrophe. Power Query itself never
evaluates formulas -- the guard exists for the person who saves the URL's
response as a .csv and double-clicks it, which somebody always eventually
does. Numbers keep their sign; the JSON is verbatim. Anyone whose data
legitimately begins with "=" reads it exactly from .json, and the CSV says
which rule changed it.
"""

import csv
import io
import json
from datetime import date, datetime
from decimal import Decimal

from app.export.sheets import looks_like_formula


def _cell(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float, Decimal)):
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    text = str(value)
    return f"'{text}" if looks_like_formula(text) else text


def to_csv(columns: list[str], rows: list[list]) -> str:
    buffer = io.StringIO()
    # \r\n per RFC 4180, and QUOTE_MINIMAL so a value holding a comma or a
    # newline is quoted rather than splitting the row.
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow([_cell(v) for v in row])
    return buffer.getvalue()


def _json_cell(value: object) -> object:
    if isinstance(value, Decimal):
        # A number, not a string: PQ types the column from the value.
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def to_json(columns: list[str], rows: list[list], truncated: bool) -> str:
    return json.dumps(
        {
            "columns": columns,
            "rows": [[_json_cell(v) for v in row] for row in rows],
            "truncated": truncated,
        },
        ensure_ascii=False,
    )
