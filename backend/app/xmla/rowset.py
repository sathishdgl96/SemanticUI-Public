"""Serialise a Discover answer as an XMLA rowset.

Every Discover response is the same envelope: a <return><root> carrying an
inline XML Schema describing the columns, then one <row> per result. MSOLAP
validates the schema and silently misbehaves without it, so the schema is not
optional decoration -- it is generated from the same column list as the rows,
which is what makes the two impossible to desynchronise.

Column names in rowsets use characters XML element names cannot carry
("[Restrictions]" and friends do not occur here, but spaces could); rowset
columns therefore keep to identifier-safe names by construction.
"""

from xml.sax.saxutils import escape

from app.xmla.soap import ROWSET_NS, attr

#: Types the schemas below actually use. `int` is xsd:int, everything else
#: is a string; booleans are the literal "true"/"false" the spec wants.
_XSD = {"string": "xsd:string", "int": "xsd:int", "boolean": "xsd:boolean",
        "unsignedShort": "xsd:unsignedShort", "unsignedInt": "xsd:unsignedInt",
        "short": "xsd:short", "dateTime": "xsd:dateTime",
        #: "uuid" is the named simpleType the schema declares itself (the
        #: shape Excel-accepted servers use for *_GUID columns); "untyped"
        #: omits the type attribute entirely.
        "uuid": "uuid", "untyped": None}

#: Declared once per schema when any column is a uuid, byte-for-byte the
#: pattern type Mondrian serves to Excel.
_UUID_TYPE = (
    '<xsd:simpleType name="uuid"><xsd:restriction base="xsd:string">'
    '<xsd:pattern value="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}'
    '-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"/>'
    "</xsd:restriction></xsd:simpleType>"
)


class Column:
    def __init__(self, name: str, type_: str = "string", *, required: bool = False) -> None:
        self.name = name
        self.type = type_
        #: Required columns are declared without minOccurs="0". The flag is
        #: as load-bearing as the type: it is part of the layout the client
        #: binds against.
        self.required = required


def rows_to_xml(columns: list[Column], rows: list[dict]) -> str:
    """The <return> element for a Discover response."""
    parts = []
    for c in columns:
        xsd_type = _XSD[c.type]
        type_attr = f' type="{xsd_type}"' if xsd_type else ""
        min_attr = "" if c.required else ' minOccurs="0"'
        parts.append(
            f'<xsd:element sql:field="{attr(c.name)}" name="{attr(c.name)}"'
            f"{type_attr}{min_attr}/>"
        )
    fields = "".join(parts)
    uuid_type = _UUID_TYPE if any(c.type == "uuid" for c in columns) else ""
    schema = (
        f'<xsd:schema targetNamespace="{ROWSET_NS}" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        f'xmlns="{ROWSET_NS}" '
        'xmlns:sql="urn:schemas-microsoft-com:xml-sql" '
        'elementFormDefault="qualified">'
        '<xsd:element name="root">'
        "<xsd:complexType><xsd:sequence>"
        '<xsd:element maxOccurs="unbounded" minOccurs="0" name="row" type="row"/>'
        "</xsd:sequence></xsd:complexType></xsd:element>"
        f"{uuid_type}"
        '<xsd:complexType name="row"><xsd:sequence>'
        f"{fields}"
        "</xsd:sequence></xsd:complexType>"
        "</xsd:schema>"
    )
    body_rows = []
    for row in rows:
        cells = []
        for c in columns:
            value = row.get(c.name)
            if value is None:
                continue  # minOccurs=0: absent, not empty
            if isinstance(value, bool):
                text = "true" if value else "false"
            else:
                text = escape(str(value))
            cells.append(f"<{c.name}>{text}</{c.name}>")
        body_rows.append(f"<row>{''.join(cells)}</row>")
    return (
        '<DiscoverResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        f'<root xmlns="{ROWSET_NS}" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
        f"{schema}{''.join(body_rows)}"
        "</root></return></DiscoverResponse>"
    )
