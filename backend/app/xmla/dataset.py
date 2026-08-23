"""Render an MDX result as the mddataset shape Excel accepts.

The inline XSD below is byte-for-byte the schema Mondrian serves to Excel
(captured in their integration fixtures) -- the one shape a real Excel has
demonstrably consumed. Everything here builds around it: OlapInfo declares
the axes and cell properties, Axes carries the member tuples, CellData the
values, and absent cells are simply absent (their ordinal is skipped).
"""

from xml.sax.saxutils import escape

from app.xmla.soap import attr

MDDATASET_XSD = (
    "<xsd:schema elementFormDefault=\"qualified\" targetNamespace=\"urn:schemas-microsoft-com:xml-analysis:m"
    "ddataset\" xmlns=\"urn:schemas-microsoft-com:xml-analysis:mddataset\" xmlns:sql=\"urn:schemas-microsoft-"
    "com:xml-sql\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchem"
    "a-instance\"><xsd:complexType name=\"MemberType\"><xsd:sequence><xsd:element name=\"UName\" type=\"xsd:str"
    "ing\"/><xsd:element name=\"Caption\" type=\"xsd:string\"/><xsd:element name=\"LName\" type=\"xsd:string\"/><x"
    "sd:element name=\"LNum\" type=\"xsd:unsignedInt\"/><xsd:element name=\"DisplayInfo\" type=\"xsd:unsignedInt"
    "\"/><xsd:sequence maxOccurs=\"unbounded\" minOccurs=\"0\"><xsd:any maxOccurs=\"unbounded\" processContents="
    "\"lax\"/></xsd:sequence></xsd:sequence><xsd:attribute name=\"Hierarchy\" type=\"xsd:string\"/></xsd:comple"
    "xType><xsd:complexType name=\"PropType\"><xsd:attribute name=\"name\" type=\"xsd:string\"/></xsd:complexTy"
    "pe><xsd:complexType name=\"TupleType\"><xsd:sequence maxOccurs=\"unbounded\"><xsd:element name=\"Member\" "
    "type=\"MemberType\"/></xsd:sequence></xsd:complexType><xsd:complexType name=\"MembersType\"><xsd:sequenc"
    "e maxOccurs=\"unbounded\"><xsd:element name=\"Member\" type=\"MemberType\"/></xsd:sequence><xsd:attribute "
    "name=\"Hierarchy\" type=\"xsd:string\"/></xsd:complexType><xsd:complexType name=\"TuplesType\"><xsd:sequen"
    "ce maxOccurs=\"unbounded\"><xsd:element name=\"Tuple\" type=\"TupleType\"/></xsd:sequence></xsd:complexTyp"
    "e><xsd:complexType name=\"CrossProductType\"><xsd:sequence><xsd:choice maxOccurs=\"unbounded\" minOccurs"
    "=\"0\"><xsd:element name=\"Members\" type=\"MembersType\"/><xsd:element name=\"Tuples\" type=\"TuplesType\"/><"
    "/xsd:choice></xsd:sequence><xsd:attribute name=\"Size\" type=\"xsd:unsignedInt\"/></xsd:complexType><xsd"
    ":complexType name=\"OlapInfo\"><xsd:sequence><xsd:element name=\"CubeInfo\"><xsd:complexType><xsd:sequen"
    "ce><xsd:element maxOccurs=\"unbounded\" name=\"Cube\"><xsd:complexType><xsd:sequence><xsd:element name=\""
    "CubeName\" type=\"xsd:string\"/></xsd:sequence></xsd:complexType></xsd:element></xsd:sequence></xsd:com"
    "plexType></xsd:element><xsd:element name=\"AxesInfo\"><xsd:complexType><xsd:sequence><xsd:element maxO"
    "ccurs=\"unbounded\" name=\"AxisInfo\"><xsd:complexType><xsd:sequence><xsd:element maxOccurs=\"unbounded\" "
    "minOccurs=\"0\" name=\"HierarchyInfo\"><xsd:complexType><xsd:sequence><xsd:sequence maxOccurs=\"unbounded"
    "\"><xsd:element name=\"UName\" type=\"PropType\"/><xsd:element name=\"Caption\" type=\"PropType\"/><xsd:eleme"
    "nt name=\"LName\" type=\"PropType\"/><xsd:element name=\"LNum\" type=\"PropType\"/><xsd:element maxOccurs=\"u"
    "nbounded\" minOccurs=\"0\" name=\"DisplayInfo\" type=\"PropType\"/></xsd:sequence><xsd:sequence><xsd:any ma"
    "xOccurs=\"unbounded\" minOccurs=\"0\" processContents=\"lax\"/></xsd:sequence></xsd:sequence><xsd:attribut"
    "e name=\"name\" type=\"xsd:string\" use=\"required\"/></xsd:complexType></xsd:element></xsd:sequence><xsd:"
    "attribute name=\"name\" type=\"xsd:string\"/></xsd:complexType></xsd:element></xsd:sequence></xsd:comple"
    "xType></xsd:element><xsd:element name=\"CellInfo\"><xsd:complexType><xsd:sequence><xsd:sequence maxOcc"
    "urs=\"unbounded\" minOccurs=\"0\"><xsd:choice><xsd:element name=\"Value\" type=\"PropType\"/><xsd:element na"
    "me=\"FmtValue\" type=\"PropType\"/><xsd:element name=\"BackColor\" type=\"PropType\"/><xsd:element name=\"For"
    "eColor\" type=\"PropType\"/><xsd:element name=\"FontName\" type=\"PropType\"/><xsd:element name=\"FontSize\" "
    "type=\"PropType\"/><xsd:element name=\"FontFlags\" type=\"PropType\"/><xsd:element name=\"FormatString\" typ"
    "e=\"PropType\"/><xsd:element name=\"NonEmptyBehavior\" type=\"PropType\"/><xsd:element name=\"SolveOrder\" t"
    "ype=\"PropType\"/><xsd:element name=\"Updateable\" type=\"PropType\"/><xsd:element name=\"Visible\" type=\"Pr"
    "opType\"/><xsd:element name=\"Expression\" type=\"PropType\"/></xsd:choice></xsd:sequence><xsd:sequence m"
    "axOccurs=\"unbounded\" minOccurs=\"0\"><xsd:any maxOccurs=\"unbounded\" processContents=\"lax\"/></xsd:seque"
    "nce></xsd:sequence></xsd:complexType></xsd:element></xsd:sequence></xsd:complexType><xsd:complexType"
    " name=\"Axes\"><xsd:sequence maxOccurs=\"unbounded\"><xsd:element name=\"Axis\"><xsd:complexType><xsd:choi"
    "ce maxOccurs=\"unbounded\" minOccurs=\"0\"><xsd:element name=\"CrossProduct\" type=\"CrossProductType\"/><xs"
    "d:element name=\"Tuples\" type=\"TuplesType\"/><xsd:element name=\"Members\" type=\"MembersType\"/></xsd:cho"
    "ice><xsd:attribute name=\"name\" type=\"xsd:string\"/></xsd:complexType></xsd:element></xsd:sequence></x"
    "sd:complexType><xsd:complexType name=\"CellData\"><xsd:sequence><xsd:element maxOccurs=\"unbounded\" min"
    "Occurs=\"0\" name=\"Cell\"><xsd:complexType><xsd:sequence maxOccurs=\"unbounded\"><xsd:choice><xsd:element"
    " name=\"Value\"/><xsd:element name=\"FmtValue\" type=\"xsd:string\"/><xsd:element name=\"BackColor\" type=\"x"
    "sd:unsignedInt\"/><xsd:element name=\"ForeColor\" type=\"xsd:unsignedInt\"/><xsd:element name=\"FontName\" "
    "type=\"xsd:string\"/><xsd:element name=\"FontSize\" type=\"xsd:unsignedShort\"/><xsd:element name=\"FontFla"
    "gs\" type=\"xsd:unsignedInt\"/><xsd:element name=\"FormatString\" type=\"xsd:string\"/><xsd:element name=\"N"
    "onEmptyBehavior\" type=\"xsd:unsignedShort\"/><xsd:element name=\"SolveOrder\" type=\"xsd:unsignedInt\"/><x"
    "sd:element name=\"Updateable\" type=\"xsd:unsignedInt\"/><xsd:element name=\"Visible\" type=\"xsd:unsignedI"
    "nt\"/><xsd:element name=\"Expression\" type=\"xsd:string\"/></xsd:choice></xsd:sequence><xsd:attribute na"
    "me=\"CellOrdinal\" type=\"xsd:unsignedInt\" use=\"required\"/></xsd:complexType></xsd:element></xsd:sequen"
    "ce></xsd:complexType><xsd:element name=\"root\"><xsd:complexType><xsd:sequence maxOccurs=\"unbounded\"><"
    "xsd:element name=\"OlapInfo\" type=\"OlapInfo\"/><xsd:element name=\"Axes\" type=\"Axes\"/><xsd:element name"
    "=\"CellData\" type=\"CellData\"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema>"
)


def member_xml(member: dict) -> str:
    """One <Member> element. Keys: hierarchy, uname, caption, lname, lnum,
    display_info, and optional properties dict (element name -> value)."""
    parts = [
        f'<Member Hierarchy="{attr(member["hierarchy"])}">',
        f"<UName>{escape(member['uname'])}</UName>",
        f"<Caption>{escape(member['caption'])}</Caption>",
        f"<LName>{escape(member['lname'])}</LName>",
        f"<LNum>{member['lnum']}</LNum>",
        f"<DisplayInfo>{member.get('display_info', 0)}</DisplayInfo>",
    ]
    for name, value in (member.get("properties") or {}).items():
        parts.append(f"<{name}>{escape(str(value))}</{name}>")
    parts.append("</Member>")
    return "".join(parts)


def axis_xml(name: str, tuples: list) -> str:
    inner = "".join(
        "<Tuple>" + "".join(member_xml(m) for m in tup) + "</Tuple>"
        for tup in tuples
    )
    return f'<Axis name="{attr(name)}"><Tuples>{inner}</Tuples></Axis>'


def axis_info_xml(name: str, hierarchies: list) -> str:
    """`hierarchies` are (unique name, extra property names) pairs.

    Unique names ([ORDERS].[ORDER_STATUS], [Measures]): Excel matches the
    axis back to the hierarchy it queried by this string. Every member
    property a Member element carries MUST be declared here first --
    ADOMD's ReadMembers dies on an undeclared property element (verified
    live), and Excel behaves the same.
    """
    infos = []
    for h, props in hierarchies:
        extra = "".join(
            f'<{p} name="{attr(h)}.[{p}]" type="xsd:string"/>' for p in props
        )
        infos.append(
            f'<HierarchyInfo name="{attr(h)}">'
            f'<UName name="{attr(h)}.[MEMBER_UNIQUE_NAME]"/>'
            f'<Caption name="{attr(h)}.[MEMBER_CAPTION]"/>'
            f'<LName name="{attr(h)}.[LEVEL_UNIQUE_NAME]"/>'
            f'<LNum name="{attr(h)}.[LEVEL_NUMBER]"/>'
            f'<DisplayInfo name="{attr(h)}.[DISPLAY_INFO]"/>'
            f"{extra}"
            "</HierarchyInfo>"
        )
    return f'<AxisInfo name="{attr(name)}">{"".join(infos)}</AxisInfo>'


def cell_xml(ordinal: int, value) -> str:
    """One <Cell>. None never reaches here -- absent cells are skipped."""
    if isinstance(value, bool):
        xsi, text = "xsd:boolean", ("true" if value else "false")
    elif isinstance(value, int):
        xsi, text = "xsd:int", str(value)
    elif isinstance(value, float):
        xsi, text = "xsd:double", repr(value)
    else:
        try:  # Decimal and friends
            text = str(value)
            float(text)
            xsi = "xsd:double"
        except (TypeError, ValueError):
            xsi, text = "xsd:string", str(value)
    return (
        f'<Cell CellOrdinal="{ordinal}">'
        f'<Value xsi:type="{xsi}">{escape(text)}</Value>'
        "<FormatString>Standard</FormatString>"
        "</Cell>"
    )


def mddataset(cube_name: str, axes: list, cells: list) -> str:
    """The full ExecuteResponse body.

    axes: list of (name, hierarchy names, tuples); must already include the
    SlicerAxis last, matching how AxesInfo lists it.
    cells: (ordinal, value) pairs, Nones already dropped.
    """
    axes_info = "".join(axis_info_xml(n, hs) for n, hs, _ in axes)
    axes_xml = "".join(axis_xml(n, tups) for n, _, tups in axes)
    cell_data = "".join(cell_xml(o, v) for o, v in cells)
    return (
        '<ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        '<root xmlns="urn:schemas-microsoft-com:xml-analysis:mddataset" '
        'xmlns:EX="urn:schemas-microsoft-com:xml-analysis:exception" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f"{MDDATASET_XSD}"
        "<OlapInfo>"
        f"<CubeInfo><Cube><CubeName>{escape(cube_name)}</CubeName></Cube></CubeInfo>"
        f"<AxesInfo>{axes_info}</AxesInfo>"
        "<CellInfo>"
        '<Value name="VALUE"/>'
        '<FormatString name="FORMAT_STRING"/>'
        '<Language name="LANGUAGE"/>'
        '<BackColor name="BACK_COLOR"/>'
        '<ForeColor name="FORE_COLOR"/>'
        '<FontFlags name="FONT_FLAGS"/>'
        "</CellInfo>"
        "</OlapInfo>"
        f"<Axes>{axes_xml}</Axes>"
        f"<CellData>{cell_data}</CellData>"
        "</root></return></ExecuteResponse>"
    )
