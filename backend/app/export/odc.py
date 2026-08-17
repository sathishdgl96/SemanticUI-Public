"""An Office Data Connection file: Excel's own "here is a live query" format.

Opening one in Excel creates a connected table that refreshes straight from
Snowflake. It replaces four manual steps (Data -> Get Data -> From Database ->
From Snowflake, then paste) with a double-click.

WHAT IS NOT IN THE FILE: any credential. The connection string names the
server and the driver and stops there, so Excel prompts for a sign-in and the
workbook refreshes as whoever opened it. That is the same rule the rest of
this product runs on -- every query on the user's own Snowflake credentials --
and a file that carried a password would quietly break it the moment anyone
forwarded the workbook.

WHAT THE FILE NEEDS: the Snowflake ODBC driver installed on the machine that
opens it. ODC reaches ODBC through the MSDASQL OLE DB provider; without the
driver, Excel reports one it cannot find. There is no way around that from
here -- Power Query's own Snowflake connector lives in a binary DataMashup
part of an .xlsx, which is not a format anything should be hand-authoring.
"""

from xml.sax.saxutils import escape

#: Snowflake's ODBC driver name, as it registers itself on Windows.
DRIVER = "SnowflakeDSIIDriver"


def _connection_string(account: str, database: str, schema: str, warehouse: str) -> str:
    parts = [
        f"Driver={DRIVER}",
        f"Server={account}.snowflakecomputing.com",
        f"Database={database}",
        f"Schema={schema}",
    ]
    if warehouse:
        parts.append(f"Warehouse={warehouse}")
    inner = ";".join(parts)
    # MSDASQL is the OLE DB provider that fronts an ODBC driver. Extended
    # Properties carries the ODBC connection string, quoted as one value.
    return f'Provider=MSDASQL.1;Persist Security Info=False;Extended Properties="{inner}"'


def build_odc(
    *,
    title: str,
    sql: str,
    account: str,
    database: str,
    schema: str,
    warehouse: str = "",
) -> str:
    """One ODC document, ready to be downloaded.

    `sql` must be the LITERAL statement (see export/literals.py). Excel supplies
    no bind parameters, so a statement full of `?` placeholders would arrive
    asking for values nobody can give it.
    """
    connection = escape(_connection_string(account, database, schema, warehouse))
    return (
        '<html xmlns:o="urn:schemas-microsoft-com:office:office" '
        'xmlns="http://www.w3.org/TR/REC-html40">\n'
        "<head>\n"
        '<meta http-equiv="Content-Type" content="text/x-ms-odc; charset=utf-8">\n'
        '<meta name="ProgId" content="ODC.Table">\n'
        '<meta name="SourceType" content="OLEDB">\n'
        f"<title>{escape(title)}</title>\n"
        '<xml id="msodc">\n'
        '<odc:OfficeDataConnection xmlns:odc="urn:schemas-microsoft-com:office:odc" '
        'xmlns="http://www.w3.org/TR/REC-html40">\n'
        '<odc:Connection odc:Type="OLEDB">\n'
        f"<odc:ConnectionString>{connection}</odc:ConnectionString>\n"
        "<odc:CommandType>SQL</odc:CommandType>\n"
        f"<odc:CommandText>{escape(sql)}</odc:CommandText>\n"
        "</odc:Connection>\n"
        "</odc:OfficeDataConnection>\n"
        "</xml>\n"
        "</head>\n"
        "</html>\n"
    )


def filename_for(title: str) -> str:
    """A filename a browser and a filesystem will both accept.

    A title made entirely of punctuation sanitises to underscores, which is a
    legal filename and a useless one -- so the fallback is keyed on whether
    anything readable survived, not on whether the string is empty.
    """
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in title).strip()
    if not any(c.isalnum() for c in safe):
        safe = "query"
    return f"{safe[:80]}.odc"
