"""Make an exported workbook refreshable: data now, live connection built in.

The workbook already carries the numbers. This adds, per data sheet, the three
OOXML parts Excel needs to treat that sheet's range as an external data query:
a connection (server + SQL), a table over the range, and a query table binding
the two. Opening the file shows the exported numbers immediately; Data ->
Refresh re-runs the SQL against Snowflake.

It works by patching the finished .xlsx, because xlsxwriter has no API for
connections. That is unusual enough to say plainly: everything here edits a zip
of XML parts, and a part left unreferenced or a relationship left dangling is
how Excel comes to say "we found a problem with some content".

NO CREDENTIAL IS WRITTEN. The connection string names the driver, the server
and the database; Excel prompts for a sign-in, so the workbook refreshes as
whoever opened it. A workbook that carried a password would hand it to
everyone it was ever forwarded to.

NEEDS THE SNOWFLAKE ODBC DRIVER on the machine that refreshes. There is no way
around that from here: the alternative is Power Query, whose definition lives
in an undocumented binary part that nothing should be hand-authoring.
"""

import io
import re
import zipfile
from dataclasses import dataclass
from xml.sax.saxutils import escape, quoteattr

CONTENT_TYPES = "[Content_Types].xml"
RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_BASE = "application/vnd.openxmlformats-officedocument.spreadsheetml"

#: Snowflake's ODBC driver, as it registers itself on Windows.
DRIVER = "SnowflakeDSIIDriver"


@dataclass
class LiveSheet:
    """One sheet that should be refreshable."""

    title: str
    sql: str
    columns: list[str]
    rows: int


def _column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _table_name(title: str, taken: set[str]) -> str:
    """A defined name Excel accepts: letters, digits and underscores only."""
    cleaned = re.sub(r"\W", "_", title) or "Query"
    if not cleaned[0].isalpha() and cleaned[0] != "_":
        cleaned = f"_{cleaned}"
    name = cleaned[:200]
    suffix = 2
    while name.lower() in taken:
        name = f"{cleaned[:195]}_{suffix}"
        suffix += 1
    taken.add(name.lower())
    return name


def _unique_columns(columns: list[str]) -> list[str]:
    """Excel refuses a table with duplicate or empty column names."""
    seen: dict[str, int] = {}
    out: list[str] = []
    for index, raw in enumerate(columns):
        name = (raw or "").strip() or f"Column{index + 1}"
        key = name.lower()
        if key in seen:
            seen[key] += 1
            name = f"{name}_{seen[key]}"
        else:
            seen[key] = 1
        out.append(name)
    return out


def connection_string(account: str, database: str, schema: str, warehouse: str) -> str:
    parts = [
        "ODBC",
        f"DRIVER={{{DRIVER}}}",
        f"SERVER={account}.snowflakecomputing.com",
        f"DATABASE={database}",
        f"SCHEMA={schema}",
    ]
    if warehouse:
        parts.append(f"WAREHOUSE={warehouse}")
    return ";".join(parts)


def _sheet_parts(archive: dict[str, bytes]) -> dict[str, str]:
    """Sheet display name -> its part path, read from the workbook itself.

    Resolved rather than assumed: sheet order and file numbering are
    xlsxwriter's business, and guessing "the second sheet is sheet2.xml" is the
    kind of assumption that holds until it does not.
    """
    workbook = archive["xl/workbook.xml"].decode("utf-8")
    rels = archive["xl/_rels/workbook.xml.rels"].decode("utf-8")
    targets = dict(
        re.findall(r'Id="([^"]+)"[^>]*?Target="([^"]+)"', rels)
    )
    found: dict[str, str] = {}
    for name, rid in re.findall(
        r'<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"', workbook
    ):
        target = targets.get(rid, "")
        if not target:
            continue
        path = target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"
        found[name] = path
    return found


def add_live_connections(
    xlsx: bytes,
    sheets: list[LiveSheet],
    *,
    account: str,
    database: str,
    schema: str,
    warehouse: str = "",
) -> bytes:
    """Return the workbook with a refreshable connection per sheet.

    A sheet with no rows is skipped: a table needs a range, and an empty one is
    the shape Excel repairs rather than opens.
    """
    with zipfile.ZipFile(io.BytesIO(xlsx)) as source:
        archive = {item.filename: source.read(item.filename) for item in source.infolist()}

    parts = _sheet_parts(archive)
    live = [s for s in sheets if s.rows > 0 and s.columns and parts.get(s.title)]
    if not live:
        return xlsx

    dsn = connection_string(account, database, schema, warehouse)
    taken: set[str] = set()
    connections: list[str] = []
    overrides: list[str] = []

    for index, sheet in enumerate(live, start=1):
        name = _table_name(sheet.title, taken)
        columns = _unique_columns(sheet.columns)
        last = _column_letter(len(columns) - 1)
        # The header row is part of the table, so the range starts at row 1.
        ref = f"A1:{last}{sheet.rows + 1}"

        connections.append(
            f'<connection id="{index}" name={quoteattr(name)} type="1" '
            f'refreshedVersion="8" background="1" saveData="1">'
            f"<dbPr connection={quoteattr(dsn)} command={quoteattr(sheet.sql)} "
            f'commandType="2"/></connection>'
        )

        table_columns = "".join(
            f'<tableColumn id="{n}" uniqueName="{n}" name={quoteattr(c)} '
            f'queryTableFieldId="{n}"/>'
            for n, c in enumerate(columns, start=1)
        )
        archive[f"xl/tables/table{index}.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'id="{index}" name={quoteattr(name)} displayName={quoteattr(name)} '
            f'ref="{ref}" tableType="queryTable" totalsRowShown="0">'
            f'<autoFilter ref="{ref}"/>'
            f'<tableColumns count="{len(columns)}">{table_columns}</tableColumns>'
            '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" '
            'showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>'
            "</table>"
        ).encode("utf-8")

        query_fields = "".join(
            f'<queryTableField id="{n}" name={quoteattr(c)} tableColumnId="{n}"/>'
            for n, c in enumerate(columns, start=1)
        )
        archive[f"xl/queryTables/queryTable{index}.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<queryTable xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'name={quoteattr(name)} connectionId="{index}" autoFormatId="16" '
            'applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" '
            'applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="0">'
            f'<queryTableRefresh nextId="{len(columns) + 1}">'
            f'<queryTableFields count="{len(columns)}">{query_fields}</queryTableFields>'
            "</queryTableRefresh></queryTable>"
        ).encode("utf-8")

        archive[f"xl/tables/_rels/table{index}.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{RELS_NS}">'
            f'<Relationship Id="rId1" Type="{RELS_NS}/queryTable" '
            f'Target="../queryTables/queryTable{index}.xml"/></Relationships>'
        ).encode("utf-8")

        _attach_table(archive, parts[sheet.title], index)
        overrides += [
            f'<Override PartName="/xl/tables/table{index}.xml" '
            f'ContentType="{CT_BASE}.table+xml"/>',
            f'<Override PartName="/xl/queryTables/queryTable{index}.xml" '
            f'ContentType="{CT_BASE}.queryTable+xml"/>',
        ]

    archive["xl/connections.xml"] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + "".join(connections)
        + "</connections>"
    ).encode("utf-8")
    overrides.append(
        f'<Override PartName="/xl/connections.xml" ContentType="{CT_BASE}.connections+xml"/>'
    )

    _add_relationship(
        archive,
        "xl/_rels/workbook.xml.rels",
        f"{RELS_NS}/connections",
        "connections.xml",
    )
    types = archive[CONTENT_TYPES].decode("utf-8")
    archive[CONTENT_TYPES] = types.replace(
        "</Types>", "".join(overrides) + "</Types>"
    ).encode("utf-8")

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for name, data in archive.items():
            target.writestr(name, data)
    return out.getvalue()


def _next_rel_id(rels: str) -> str:
    used = {int(n) for n in re.findall(r'Id="rId(\d+)"', rels)}
    return f"rId{max(used) + 1 if used else 1}"


def _add_relationship(archive: dict[str, bytes], path: str, type_: str, target: str) -> str:
    existing = archive.get(path)
    if existing is None:
        rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="{RELS_NS}"></Relationships>'
        )
    else:
        rels = existing.decode("utf-8")
    rid = _next_rel_id(rels)
    entry = f'<Relationship Id="{rid}" Type="{type_}" Target={quoteattr(target)}/>'
    archive[path] = rels.replace("</Relationships>", entry + "</Relationships>").encode(
        "utf-8"
    )
    return rid


def _attach_table(archive: dict[str, bytes], sheet_path: str, index: int) -> None:
    """Point a worksheet at its table part.

    `<tableParts>` has to be the LAST child of `<worksheet>` -- the schema is
    a sequence, and Excel rejects the part outright if it appears earlier.
    """
    rels_path = sheet_path.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels"
    rid = _add_relationship(
        archive, rels_path, f"{RELS_NS}/table", f"../tables/table{index}.xml"
    )
    sheet = archive[sheet_path].decode("utf-8")
    archive[sheet_path] = sheet.replace(
        "</worksheet>",
        f'<tableParts count="1"><tablePart r:id="{rid}"/></tableParts></worksheet>',
    ).encode("utf-8")


def summary_note(sheets: list[LiveSheet]) -> str:
    """One line for the Summary sheet, so the file explains its own behaviour."""
    if not sheets:
        return ""
    return (
        "Live connection: Data -> Refresh All re-runs each sheet's query against "
        f"Snowflake as you. Needs the {DRIVER} ODBC driver installed. No "
        "credential is stored in this file."
    )


__all__ = [
    "DRIVER",
    "LiveSheet",
    "add_live_connections",
    "connection_string",
    "summary_note",
    "escape",
]
