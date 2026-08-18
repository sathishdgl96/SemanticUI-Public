"""Answers to XMLA Discover: the semantic catalog in Analysis Services terms.

The mapping, stated once:

    catalog                  -> the fixed name "SemanticUI"
    cube                     -> one semantic view ("DB.SCHEMA.VIEW")
    dimension                -> one entity (logical table) of that view
    attribute hierarchy      -> one dimension field: two levels, (All) + leaf
    measure                  -> one metric

Attribute hierarchies are the deliberate choice, not a shortcut: they are how
Analysis Services itself models plain columns, and they are exactly what makes
every field draggable, nestable, sliceable and filterable in an Excel pivot.

Unknown request types answer an EMPTY rowset rather than a fault. Observed
behaviour drives that: MSOLAP treats a fault mid-handshake as fatal but walks
happily past an empty answer to a rowset it merely probed for.
"""

from app.xmla.rowset import Column, rows_to_xml

CATALOG = "SemanticUI"


def cube_name(view: dict) -> str:
    return f"{view['database']}.{view['schema']}.{view['name']}"


def parse_cube_name(name: str) -> tuple[str, str, str]:
    database, schema, view = name.split(".", 2)
    return database, schema, view


def _unique_name(*parts: str) -> str:
    return ".".join(f"[{p}]" for p in parts)


def handle(session, request) -> str:
    handler = _HANDLERS.get(request.request_type, _empty)
    return handler(session, request)


def _empty(session, request) -> str:
    return rows_to_xml([Column("PropertyName")], [])


# --- server plumbing ---------------------------------------------------------


_PROPERTY_COLUMNS = [
    Column("PropertyName"), Column("PropertyDescription"), Column("PropertyType"),
    Column("PropertyAccessType"), Column("IsRequired", "boolean"), Column("Value"),
]

#: What this server admits to. MSOLAP reads these to decide which dialect
#: features to use; conservative values steer it toward plain MDX.
_PROPERTIES = {
    "Catalog": ("string", "ReadWrite", CATALOG),
    "ServerName": ("string", "Read", "SemanticUI"),
    "ProviderName": ("string", "Read", "SemanticUI XMLA"),
    # Four-part, because that is the shape SSAS emits and MSOLAP parses
    # version strings to decide capabilities.
    "ProviderVersion": ("string", "Read", "16.0.1000.0"),
    "DBMSVersion": ("string", "Read", "16.0.1000.0"),
    "ProviderType": ("int", "Read", "6"),
    # The five properties in the client's VERY FIRST request. SSAS answers
    # all of them; the first build answered one. The ActivityID pair and
    # ApplicationContext are per-request WRITABLE properties (tracing ids) --
    # a client that intends to set them may require the server to admit they
    # exist before it proceeds.
    "DbpropMsmdOptimizeResponse": ("int", "Read", "0"),
    "DbpropMsmdActivityID": ("string", "ReadWrite", ""),
    "DbpropMsmdCurrentActivityID": ("string", "ReadWrite", ""),
    "ApplicationContext": ("string", "ReadWrite", ""),
    "MdpropMdxSubqueries": ("int", "Read", "31"),
    "DbpropMsmdSubqueries": ("int", "Read", "1"),
    "DbpropMsmdMDXCompatibility": ("int", "Read", "1"),
    # The MDX capability mask Excel asks about by name before building a
    # single pivot. These are SSAS's own answers, deliberately: the first
    # attempt claimed NamedSets=0 to avoid CREATE SET, and the client ended
    # the session right after reading the capabilities -- a server that
    # cannot hold a named set is a server Excel refuses to pivot against.
    # Claiming them is a commitment: Execute must accept CREATE SET.
    "MdpropMdxDdlExtensions": ("int", "Read", "3"),
    "MdpropMdxDrillFunctions": ("int", "Read", "3"),
    "MdpropMdxNamedSets": ("int", "Read", "15"),
}

#: OLE DB rowset GUIDs. MSOLAP identifies a rowset BY GUID, not by name --
#: a capability list without them reads as "supports nothing" (observed:
#: the client sent EndSession straight after three tries). The MDSCHEMA
#: family is the published C8B522xx sequence.
_SCHEMA_GUIDS = {
    "DISCOVER_DATASOURCES": "06C03D41-F66D-49F3-B1B8-987F7AF4CF18",
    "DISCOVER_PROPERTIES": "4B40ADEC-1AFE-4B54-B1EA-3E1EAB28DFF0",
    "DISCOVER_SCHEMA_ROWSETS": "EEA0302B-7922-4992-8991-0E605D0E5593",
    "DISCOVER_KEYWORDS": "1426C443-4CDD-4A40-8F45-572FAB9BBAA1",
    "DISCOVER_LITERALS": "C3EF5ECB-0A07-4665-A140-B075722DBDC2",
    "DBSCHEMA_CATALOGS": "C8B52211-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_CUBES": "C8B522D8-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_DIMENSIONS": "C8B522D9-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_HIERARCHIES": "C8B522DA-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_LEVELS": "C8B522DB-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_MEASURES": "C8B522DC-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_PROPERTIES": "C8B522DD-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_MEMBERS": "C8B522DE-5CF3-11CE-ADE5-00AA0044773D",
    "MDSCHEMA_MEASUREGROUPS": "E1625EBF-FA96-42FD-BEA6-DB90ADAFD96B",
    "MDSCHEMA_MEASUREGROUP_DIMENSIONS": "A07CCD33-8148-11D0-87BB-00C04FC33942",
    "MDSCHEMA_FUNCTIONS": "A07CCD07-8148-11D0-87BB-00C04FC33942",
    "MDSCHEMA_ACTIONS": "A07CCD08-8148-11D0-87BB-00C04FC33942",
    "MDSCHEMA_SETS": "A07CCD0B-8148-11D0-87BB-00C04FC33942",
    "MDSCHEMA_KPIS": "2AE44109-ED3D-4842-B16F-B694D1CB0E3F",
    "DISCOVER_ENUMERATORS": "55A9E78B-ACCB-45B4-95A6-94C5065617A7",
}


def _discover_properties(session, request) -> str:
    wanted = request.restrictions.get("PropertyName")
    names = [n for n in wanted if n in _PROPERTIES] if wanted else list(_PROPERTIES)
    rows = [
        {
            "PropertyName": name,
            "PropertyType": _PROPERTIES[name][0],
            "PropertyAccessType": _PROPERTIES[name][1],
            "IsRequired": False,
            "Value": _PROPERTIES[name][2],
        }
        for name in names
    ]
    return rows_to_xml(_PROPERTY_COLUMNS, rows)


def _discover_datasources(session, request) -> str:
    columns = [
        Column("DataSourceName"), Column("DataSourceDescription"), Column("URL"),
        Column("DataSourceInfo"), Column("ProviderName"), Column("ProviderType"),
        Column("AuthenticationMode"),
    ]
    return rows_to_xml(columns, [{
        "DataSourceName": "SemanticUI",
        "DataSourceDescription": "Snowflake semantic views",
        "DataSourceInfo": "SemanticUI",
        "ProviderName": "SemanticUI XMLA",
        "ProviderType": "MDP",
        "AuthenticationMode": "Authenticated",
    }])


def _dbschema_catalogs(session, request) -> str:
    columns = [Column("CATALOG_NAME"), Column("DESCRIPTION"), Column("ROLES")]
    return rows_to_xml(columns, [{
        "CATALOG_NAME": CATALOG,
        "DESCRIPTION": "Snowflake semantic views",
        "ROLES": "",
    }])


# --- the cube catalog --------------------------------------------------------


def _restricted_views(session, request) -> list[dict]:
    """The session's views, narrowed by a CUBE_NAME restriction if present."""
    views = session.list_views()
    wanted = request.restrictions.get("CUBE_NAME")
    if wanted and wanted[0]:
        views = [v for v in views if cube_name(v) == wanted[0]]
    return views


def _mdschema_cubes(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("CUBE_TYPE"),
        Column("LAST_SCHEMA_UPDATE", "dateTime"),
        Column("LAST_DATA_UPDATE", "dateTime"),
        Column("DESCRIPTION"),
        Column("IS_DRILLTHROUGH_ENABLED", "boolean"),
        Column("IS_LINKABLE", "boolean"),
        Column("IS_WRITE_ENABLED", "boolean"),
        Column("IS_SQL_ENABLED", "boolean"),
        Column("CUBE_CAPTION"), Column("BASE_CUBE_NAME"),
        Column("CUBE_SOURCE", "unsignedShort"),
        Column("PREFERRED_QUERY_PATTERNS", "unsignedShort"),
    ]
    # A FIXED timestamp: Excel keys its metadata cache on it, and a value
    # that moved between requests would look like a cube changing under it.
    rows = [
        {
            "CATALOG_NAME": CATALOG,
            "SCHEMA_NAME": None,
            "CUBE_NAME": cube_name(v),
            "CUBE_TYPE": "CUBE",
            "LAST_SCHEMA_UPDATE": "2024-01-01T00:00:00",
            "LAST_DATA_UPDATE": "2024-01-01T00:00:00",
            "DESCRIPTION": v.get("comment") or "",
            "IS_DRILLTHROUGH_ENABLED": False,
            "IS_LINKABLE": False,
            "IS_WRITE_ENABLED": False,
            "IS_SQL_ENABLED": False,
            "CUBE_CAPTION": v["name"],
            "BASE_CUBE_NAME": None,
            "CUBE_SOURCE": 1,
            "PREFERRED_QUERY_PATTERNS": 0,
        }
        for v in _restricted_views(session, request)
    ]
    return rows_to_xml(columns, rows)


def _mdschema_measuregroups(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("MEASUREGROUP_NAME"), Column("DESCRIPTION"),
        Column("IS_WRITE_ENABLED", "boolean"), Column("MEASUREGROUP_CAPTION"),
    ]
    rows = [
        {
            "CATALOG_NAME": CATALOG,
            "CUBE_NAME": cube_name(v),
            "MEASUREGROUP_NAME": "Measures",
            "MEASUREGROUP_CAPTION": "Measures",
            "IS_WRITE_ENABLED": False,
        }
        for v in _restricted_views(session, request)
    ]
    return rows_to_xml(columns, rows)


def _dimension_tables(detail: dict) -> list[str]:
    """Entities that actually carry dimension fields, in describe order."""
    seen: list[str] = []
    for f in detail.get("dimensions", []):
        table = f.get("table") or ""
        if table and table not in seen:
            seen.append(table)
    return seen


def _fields_of(detail: dict, table: str) -> list[dict]:
    return [f for f in detail.get("dimensions", []) if (f.get("table") or "") == table]


def _mdschema_measuregroup_dimensions(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("MEASUREGROUP_NAME"),
        Column("DIMENSION_UNIQUE_NAME"), Column("MEASUREGROUP_CARDINALITY"),
        Column("DIMENSION_CARDINALITY"), Column("DIMENSION_IS_VISIBLE", "boolean"),
    ]
    rows = []
    for v in _restricted_views(session, request):
        detail = session.describe(v["database"], v["schema"], v["name"])
        for table in _dimension_tables(detail):
            rows.append({
                "CATALOG_NAME": CATALOG,
                "CUBE_NAME": cube_name(v),
                "MEASUREGROUP_NAME": "Measures",
                "DIMENSION_UNIQUE_NAME": _unique_name(table),
                "MEASUREGROUP_CARDINALITY": "MANY",
                "DIMENSION_CARDINALITY": "ONE",
                "DIMENSION_IS_VISIBLE": True,
            })
    return rows_to_xml(columns, rows)


def _mdschema_dimensions(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("DIMENSION_NAME"),
        Column("DIMENSION_UNIQUE_NAME"), Column("DIMENSION_CAPTION"),
        Column("DIMENSION_ORDINAL", "unsignedInt"),
        Column("DIMENSION_TYPE", "unsignedShort"),
        Column("DIMENSION_CARDINALITY", "unsignedInt"),
        Column("DEFAULT_HIERARCHY"), Column("DESCRIPTION"),
        Column("IS_VIRTUAL", "boolean"),
        Column("IS_READWRITE", "boolean"),
        Column("DIMENSION_UNIQUE_SETTINGS", "int"),
        Column("DIMENSION_MASTER_NAME"),
        Column("DIMENSION_IS_VISIBLE", "boolean"),
    ]
    rows = []
    for v in _restricted_views(session, request):
        detail = session.describe(v["database"], v["schema"], v["name"])
        cube = cube_name(v)
        tables = _dimension_tables(detail)
        for ordinal, table in enumerate(tables):
            first = _fields_of(detail, table)[0]["name"]
            rows.append({
                "CATALOG_NAME": CATALOG, "CUBE_NAME": cube,
                "DIMENSION_NAME": table,
                "DIMENSION_UNIQUE_NAME": _unique_name(table),
                "DIMENSION_CAPTION": table,
                "DIMENSION_ORDINAL": ordinal,
                "DIMENSION_TYPE": 3,  # MD_DIMTYPE_OTHER
                "DIMENSION_CARDINALITY": 1000,
                "DEFAULT_HIERARCHY": _unique_name(table, first),
                "DESCRIPTION": "",
                "IS_VIRTUAL": False, "IS_READWRITE": False,
                "DIMENSION_UNIQUE_SETTINGS": 1,
                "DIMENSION_MASTER_NAME": None,
                "DIMENSION_IS_VISIBLE": True,
            })
        # The measures dimension: every cube has one, and Excel asks for it.
        rows.append({
            "CATALOG_NAME": CATALOG, "CUBE_NAME": cube,
            "DIMENSION_NAME": "Measures",
            "DIMENSION_UNIQUE_NAME": "[Measures]",
            "DIMENSION_CAPTION": "Measures",
            "DIMENSION_ORDINAL": len(tables),
            "DIMENSION_TYPE": 2,  # MD_DIMTYPE_MEASURE
            "DIMENSION_CARDINALITY": len(detail.get("metrics", [])),
            "DEFAULT_HIERARCHY": "[Measures]",
            "DESCRIPTION": "",
            "IS_VIRTUAL": False, "IS_READWRITE": False,
            "DIMENSION_UNIQUE_SETTINGS": 1,
            "DIMENSION_MASTER_NAME": None,
            "DIMENSION_IS_VISIBLE": True,
        })
    return rows_to_xml(columns, rows)


def _mdschema_hierarchies(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("DIMENSION_UNIQUE_NAME"),
        Column("HIERARCHY_NAME"), Column("HIERARCHY_UNIQUE_NAME"),
        Column("HIERARCHY_CAPTION"), Column("DIMENSION_TYPE", "unsignedShort"),
        Column("HIERARCHY_CARDINALITY", "unsignedInt"),
        Column("DEFAULT_MEMBER"), Column("ALL_MEMBER"),
        Column("DESCRIPTION"),
        Column("STRUCTURE", "unsignedShort"), Column("IS_VIRTUAL", "boolean"),
        Column("IS_READWRITE", "boolean"),
        Column("DIMENSION_UNIQUE_SETTINGS", "int"),
        Column("DIMENSION_MASTER_UNIQUE_NAME"),
        Column("DIMENSION_IS_VISIBLE", "boolean"),
        Column("HIERARCHY_ORDINAL", "unsignedInt"),
        Column("DIMENSION_IS_SHARED", "boolean"),
        Column("HIERARCHY_IS_VISIBLE", "boolean"),
        Column("HIERARCHY_ORIGIN", "unsignedShort"),
        Column("HIERARCHY_DISPLAY_FOLDER"),
        Column("INSTANCE_SELECTION", "unsignedShort"),
        Column("GROUPING_BEHAVIOR", "short"),
        Column("STRUCTURE_TYPE"),
    ]
    rows = []
    for v in _restricted_views(session, request):
        detail = session.describe(v["database"], v["schema"], v["name"])
        cube = cube_name(v)
        ordinal = 0
        for table in _dimension_tables(detail):
            for f in _fields_of(detail, table):
                unique = _unique_name(table, f["name"])
                rows.append({
                    "CATALOG_NAME": CATALOG, "SCHEMA_NAME": None,
                    "CUBE_NAME": cube,
                    "DIMENSION_UNIQUE_NAME": _unique_name(table),
                    "HIERARCHY_NAME": f["name"],
                    "HIERARCHY_UNIQUE_NAME": unique,
                    "HIERARCHY_CAPTION": f["name"],
                    "DIMENSION_TYPE": 3,
                    "HIERARCHY_CARDINALITY": 1000,
                    "DEFAULT_MEMBER": f"{unique}.[All]",
                    "ALL_MEMBER": f"{unique}.[All]",
                    "DESCRIPTION": "",
                    "STRUCTURE": 0,
                    "IS_VIRTUAL": False, "IS_READWRITE": False,
                    "DIMENSION_UNIQUE_SETTINGS": 1,
                    "DIMENSION_MASTER_UNIQUE_NAME": None,
                    "DIMENSION_IS_VISIBLE": True,
                    "HIERARCHY_ORDINAL": ordinal,
                    "DIMENSION_IS_SHARED": True,
                    "HIERARCHY_IS_VISIBLE": True,
                    "HIERARCHY_ORIGIN": 2,  # attribute hierarchy
                    "HIERARCHY_DISPLAY_FOLDER": "",
                    "INSTANCE_SELECTION": 0,
                    "GROUPING_BEHAVIOR": 1,
                    "STRUCTURE_TYPE": "Natural",
                })
                ordinal += 1
    return rows_to_xml(columns, rows)


def _mdschema_levels(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("DIMENSION_UNIQUE_NAME"),
        Column("HIERARCHY_UNIQUE_NAME"), Column("LEVEL_NAME"),
        Column("LEVEL_UNIQUE_NAME"), Column("LEVEL_CAPTION"),
        Column("LEVEL_NUMBER", "unsignedInt"),
        Column("LEVEL_CARDINALITY", "unsignedInt"),
        Column("LEVEL_TYPE", "int"),
        Column("CUSTOM_ROLLUP_SETTINGS", "int"),
        Column("LEVEL_UNIQUE_SETTINGS", "int"),
        Column("LEVEL_IS_VISIBLE", "boolean"),
        Column("DESCRIPTION"),
        Column("LEVEL_ORIGIN", "unsignedShort"),
    ]
    rows = []
    for v in _restricted_views(session, request):
        detail = session.describe(v["database"], v["schema"], v["name"])
        cube = cube_name(v)
        for table in _dimension_tables(detail):
            for f in _fields_of(detail, table):
                hierarchy = _unique_name(table, f["name"])
                rows.append({
                    "CATALOG_NAME": CATALOG, "CUBE_NAME": cube,
                    "DIMENSION_UNIQUE_NAME": _unique_name(table),
                    "HIERARCHY_UNIQUE_NAME": hierarchy,
                    "LEVEL_NAME": "(All)",
                    "LEVEL_UNIQUE_NAME": f"{hierarchy}.[(All)]",
                    "LEVEL_CAPTION": "(All)",
                    "LEVEL_NUMBER": 0, "LEVEL_CARDINALITY": 1,
                    "LEVEL_TYPE": 1,  # MDLEVEL_TYPE_ALL
                    "CUSTOM_ROLLUP_SETTINGS": 0,
                    "LEVEL_UNIQUE_SETTINGS": 3,
                    "LEVEL_IS_VISIBLE": True,
                    "DESCRIPTION": "",
                    "LEVEL_ORIGIN": 2,
                })
                rows.append({
                    "CATALOG_NAME": CATALOG, "CUBE_NAME": cube,
                    "DIMENSION_UNIQUE_NAME": _unique_name(table),
                    "HIERARCHY_UNIQUE_NAME": hierarchy,
                    "LEVEL_NAME": f["name"],
                    "LEVEL_UNIQUE_NAME": f"{hierarchy}.[{f['name']}]",
                    "LEVEL_CAPTION": f["name"],
                    "LEVEL_NUMBER": 1, "LEVEL_CARDINALITY": 1000,
                    "LEVEL_TYPE": 0,  # MDLEVEL_TYPE_REGULAR
                    "CUSTOM_ROLLUP_SETTINGS": 0,
                    "LEVEL_UNIQUE_SETTINGS": 1,
                    "LEVEL_IS_VISIBLE": True,
                    "DESCRIPTION": "",
                    "LEVEL_ORIGIN": 2,
                })
    return rows_to_xml(columns, rows)


def _mdschema_measures(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("SCHEMA_NAME"), Column("CUBE_NAME"),
        Column("MEASURE_NAME"),
        Column("MEASURE_UNIQUE_NAME"), Column("MEASURE_CAPTION"),
        Column("MEASURE_AGGREGATOR", "int"), Column("DATA_TYPE", "unsignedShort"),
        Column("NUMERIC_PRECISION", "unsignedShort"),
        Column("NUMERIC_SCALE", "short"),
        Column("DESCRIPTION"),
        Column("MEASURE_IS_VISIBLE", "boolean"), Column("MEASUREGROUP_NAME"),
        Column("MEASURE_DISPLAY_FOLDER"),
        Column("DEFAULT_FORMAT_STRING"),
    ]
    rows = []
    for v in _restricted_views(session, request):
        detail = session.describe(v["database"], v["schema"], v["name"])
        cube = cube_name(v)
        for m in detail.get("metrics", []):
            rows.append({
                "CATALOG_NAME": CATALOG, "CUBE_NAME": cube,
                "MEASURE_NAME": f"{m['table']}.{m['name']}",
                "MEASURE_UNIQUE_NAME": f"[Measures].[{m['table']}.{m['name']}]",
                "MEASURE_CAPTION": m["name"],
                # 127 = calculated/unknown: the semantic model owns the
                # aggregation, and claiming SUM here would be a lie Excel
                # might act on.
                "MEASURE_AGGREGATOR": 127,
                "DATA_TYPE": 5,  # DBTYPE_R8
                "NUMERIC_PRECISION": 16,
                "NUMERIC_SCALE": 255,
                "DESCRIPTION": m.get("comment") or "",
                "MEASURE_IS_VISIBLE": True,
                "MEASUREGROUP_NAME": "Measures",
                "MEASURE_DISPLAY_FOLDER": "",
                "DEFAULT_FORMAT_STRING": None,
            })
    return rows_to_xml(columns, rows)


#: The restrictions each rowset honours, as (name, xsd type). This is what
#: DISCOVER_SCHEMA_ROWSETS exists to communicate: the client reads it to
#: learn what it may send. Kept to what the handlers genuinely implement.
_ROWSET_RESTRICTIONS = {
    # The FULL canonical restriction list per rowset, copied from what a
    # real SSAS advertises. Excel restricts its metadata queries on
    # CUBE_SOURCE, the *_VISIBILITY columns and HIERARCHY/LEVEL_ORIGIN --
    # a server that does not advertise those restrictions is announcing it
    # cannot answer the queries Excel is about to plan.
    "DISCOVER_DATASOURCES": [("DataSourceName", "xsd:string"), ("URL", "xsd:string"), ("ProviderName", "xsd:string"), ("ProviderType", "xsd:string"), ("AuthenticationMode", "xsd:string")],
    "DISCOVER_PROPERTIES": [("PropertyName", "xsd:string")],
    "DISCOVER_SCHEMA_ROWSETS": [("SchemaName", "xsd:string")],
    "DISCOVER_ENUMERATORS": [("EnumName", "xsd:string")],
    "DISCOVER_KEYWORDS": [("Keyword", "xsd:string")],
    "DISCOVER_LITERALS": [("LiteralName", "xsd:string")],
    "DBSCHEMA_CATALOGS": [("CATALOG_NAME", "xsd:string")],
    "MDSCHEMA_CUBES": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("BASE_CUBE_NAME", "xsd:string")],
    "MDSCHEMA_DIMENSIONS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("DIMENSION_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("DIMENSION_VISIBILITY", "xsd:unsignedShort")],
    "MDSCHEMA_HIERARCHIES": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("HIERARCHY_NAME", "xsd:string"), ("HIERARCHY_UNIQUE_NAME", "xsd:string"), ("HIERARCHY_ORIGIN", "xsd:unsignedShort"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("HIERARCHY_VISIBILITY", "xsd:unsignedShort")],
    "MDSCHEMA_LEVELS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("HIERARCHY_UNIQUE_NAME", "xsd:string"), ("LEVEL_NAME", "xsd:string"), ("LEVEL_UNIQUE_NAME", "xsd:string"), ("LEVEL_ORIGIN", "xsd:unsignedShort"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("LEVEL_VISIBILITY", "xsd:unsignedShort")],
    "MDSCHEMA_MEASURES": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("MEASURE_NAME", "xsd:string"), ("MEASURE_UNIQUE_NAME", "xsd:string"), ("MEASUREGROUP_NAME", "xsd:string"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("MEASURE_VISIBILITY", "xsd:unsignedShort")],
    "MDSCHEMA_MEMBERS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("HIERARCHY_UNIQUE_NAME", "xsd:string"), ("LEVEL_UNIQUE_NAME", "xsd:string"), ("LEVEL_NUMBER", "xsd:unsignedInt"), ("MEMBER_NAME", "xsd:string"), ("MEMBER_UNIQUE_NAME", "xsd:string"), ("MEMBER_TYPE", "xsd:int"), ("MEMBER_CAPTION", "xsd:string"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("TREE_OP", "xsd:int")],
    "MDSCHEMA_PROPERTIES": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("HIERARCHY_UNIQUE_NAME", "xsd:string"), ("LEVEL_UNIQUE_NAME", "xsd:string"), ("MEMBER_UNIQUE_NAME", "xsd:string"), ("PROPERTY_TYPE", "xsd:int"), ("PROPERTY_NAME", "xsd:string"), ("PROPERTY_ORIGIN", "xsd:unsignedShort"), ("PROPERTY_CONTENT_TYPE", "xsd:int"), ("PROPERTY_VISIBILITY", "xsd:unsignedShort"), ("CUBE_SOURCE", "xsd:unsignedShort")],
    "MDSCHEMA_MEASUREGROUPS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("MEASUREGROUP_NAME", "xsd:string")],
    "MDSCHEMA_MEASUREGROUP_DIMENSIONS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("MEASUREGROUP_NAME", "xsd:string"), ("DIMENSION_UNIQUE_NAME", "xsd:string"), ("DIMENSION_VISIBILITY", "xsd:unsignedShort")],
    "MDSCHEMA_FUNCTIONS": [("LIBRARY_NAME", "xsd:string"), ("INTERFACE_NAME", "xsd:string"), ("FUNCTION_NAME", "xsd:string"), ("ORIGIN", "xsd:int")],
    "MDSCHEMA_ACTIONS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("ACTION_NAME", "xsd:string"), ("ACTION_TYPE", "xsd:int"), ("COORDINATE", "xsd:string"), ("COORDINATE_TYPE", "xsd:int"), ("INVOCATION", "xsd:int"), ("CUBE_SOURCE", "xsd:unsignedShort")],
    "MDSCHEMA_SETS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("SET_NAME", "xsd:string"), ("SCOPE", "xsd:int"), ("CUBE_SOURCE", "xsd:unsignedShort"), ("HIERARCHY_UNIQUE_NAME", "xsd:string")],
    "MDSCHEMA_KPIS": [("CATALOG_NAME", "xsd:string"), ("SCHEMA_NAME", "xsd:string"), ("CUBE_NAME", "xsd:string"), ("KPI_NAME", "xsd:string"), ("CUBE_SOURCE", "xsd:unsignedShort")],
}


def _discover_schema_rowsets(session, request) -> str:
    """The server's own capability list, in the rowset's CANONICAL shape.

    Two hard requirements, both learned from the client: rows are matched by
    SchemaGuid, and each row carries a NESTED Restrictions structure naming
    what that rowset accepts. The generic serialiser cannot express nesting,
    so this one response is assembled by hand -- the client retried it three
    times and abandoned the session when either part was missing.
    """
    from xml.sax.saxutils import escape

    from app.xmla.soap import ROWSET_NS

    names = sorted(_HANDLERS)
    wanted = request.restrictions.get("SchemaName")
    if wanted and wanted[0]:
        names = [n for n in names if n == wanted[0]]

    schema = (
        f'<xsd:schema targetNamespace="{ROWSET_NS}" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        f'xmlns="{ROWSET_NS}" '
        'xmlns:sql="urn:schemas-microsoft-com:xml-sql" '
        'elementFormDefault="qualified">'
        '<xsd:element name="root"><xsd:complexType><xsd:sequence>'
        '<xsd:element maxOccurs="unbounded" minOccurs="0" name="row" type="row"/>'
        "</xsd:sequence></xsd:complexType></xsd:element>"
        '<xsd:complexType name="row"><xsd:sequence>'
        '<xsd:element sql:field="SchemaName" name="SchemaName" type="xsd:string"/>'
        '<xsd:element sql:field="SchemaGuid" name="SchemaGuid" type="xsd:string" minOccurs="0"/>'
        '<xsd:element sql:field="Restrictions" name="Restrictions" minOccurs="0" maxOccurs="unbounded">'
        "<xsd:complexType><xsd:sequence>"
        '<xsd:element name="Name" type="xsd:string" minOccurs="0"/>'
        '<xsd:element name="Type" type="xsd:string" minOccurs="0"/>'
        "</xsd:sequence></xsd:complexType></xsd:element>"
        '<xsd:element sql:field="Description" name="Description" type="xsd:string" minOccurs="0"/>'
        '<xsd:element sql:field="RestrictionsMask" name="RestrictionsMask" type="xsd:unsignedLong" minOccurs="0"/>'
        "</xsd:sequence></xsd:complexType></xsd:schema>"
    )
    body_rows = []
    for n in names:
        restrictions = "".join(
            f"<Restrictions><Name>{escape(rn)}</Name><Type>{rt}</Type></Restrictions>"
            for rn, rt in _ROWSET_RESTRICTIONS.get(n, [])
        )
        guid = _SCHEMA_GUIDS.get(n)
        guid_el = f"<SchemaGuid>{guid}</SchemaGuid>" if guid else ""
        body_rows.append(
            f"<row><SchemaName>{escape(n)}</SchemaName>{guid_el}{restrictions}"
            f"<Description>{escape(n)}</Description></row>"
        )
    return (
        '<DiscoverResponse xmlns="urn:schemas-microsoft-com:xml-analysis">'
        "<return>"
        f'<root xmlns="{ROWSET_NS}" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema">'
        f"{schema}{''.join(body_rows)}"
        "</root></return></DiscoverResponse>"
    )


def _discover_literals(session, request) -> str:
    """Identifier quoting rules. MSOLAP consults these to build MDX."""
    columns = [
        Column("LiteralName"), Column("LiteralValue"),
        Column("LiteralInvalidChars"), Column("LiteralInvalidStartingChars"),
        Column("LiteralMaxLength", "int"),
    ]
    rows = [
        {"LiteralName": "DBLITERAL_QUOTE_PREFIX", "LiteralValue": "[",
         "LiteralMaxLength": -1},
        {"LiteralName": "DBLITERAL_QUOTE_SUFFIX", "LiteralValue": "]",
         "LiteralMaxLength": -1},
        {"LiteralName": "DBLITERAL_CATALOG_NAME", "LiteralValue": "",
         "LiteralInvalidChars": ".", "LiteralMaxLength": 255},
    ]
    return rows_to_xml(columns, rows)


def _discover_keywords(session, request) -> str:
    return rows_to_xml([Column("Keyword")], [])


def _mdschema_properties(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("PROPERTY_TYPE", "unsignedShort"),
        Column("PROPERTY_NAME"), Column("PROPERTY_CAPTION"), Column("DATA_TYPE", "unsignedShort"),
    ]
    return rows_to_xml(columns, [])


def _mdschema_kpis(session, request) -> str:
    # A cube with no KPIs answers with none -- but a server that cannot
    # answer AT ALL is a server Excel refuses to pivot against.
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("KPI_NAME"),
        Column("KPI_CAPTION"), Column("KPI_VALUE"), Column("KPI_GOAL"),
        Column("KPI_STATUS"), Column("KPI_TREND"),
    ]
    return rows_to_xml(columns, [])


def _mdschema_sets(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("SET_NAME"),
        Column("SET_CAPTION"), Column("SCOPE", "int"),
    ]
    return rows_to_xml(columns, [])


def _mdschema_functions(session, request) -> str:
    columns = [
        Column("FUNCTION_NAME"), Column("DESCRIPTION"), Column("PARAMETER_LIST"),
        Column("RETURN_TYPE", "int"), Column("ORIGIN", "int"),
    ]
    return rows_to_xml(columns, [])


def _mdschema_actions(session, request) -> str:
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("ACTION_NAME"),
        Column("COORDINATE"), Column("COORDINATE_TYPE", "int"),
    ]
    return rows_to_xml(columns, [])


def _discover_enumerators(session, request) -> str:
    columns = [
        Column("EnumName"), Column("EnumDescription"), Column("EnumType"),
        Column("ElementName"), Column("ElementDescription"), Column("ElementValue"),
    ]
    return rows_to_xml(columns, [])


def _mdschema_members(session, request) -> str:
    # Filled in with the Execute slice; an empty answer is valid until then.
    columns = [
        Column("CATALOG_NAME"), Column("CUBE_NAME"), Column("DIMENSION_UNIQUE_NAME"),
        Column("HIERARCHY_UNIQUE_NAME"), Column("LEVEL_UNIQUE_NAME"),
        Column("LEVEL_NUMBER", "unsignedInt"), Column("MEMBER_NAME"),
        Column("MEMBER_UNIQUE_NAME"), Column("MEMBER_CAPTION"),
        Column("MEMBER_TYPE", "int"), Column("CHILDREN_CARDINALITY", "unsignedInt"),
    ]
    return rows_to_xml(columns, [])


_HANDLERS = {
    "DISCOVER_SCHEMA_ROWSETS": _discover_schema_rowsets,
    "MDSCHEMA_PROPERTIES": _mdschema_properties,
    "MDSCHEMA_MEMBERS": _mdschema_members,
    "MDSCHEMA_KPIS": _mdschema_kpis,
    "MDSCHEMA_SETS": _mdschema_sets,
    "MDSCHEMA_FUNCTIONS": _mdschema_functions,
    "MDSCHEMA_ACTIONS": _mdschema_actions,
    "DISCOVER_ENUMERATORS": _discover_enumerators,
    "DISCOVER_LITERALS": _discover_literals,
    "DISCOVER_KEYWORDS": _discover_keywords,
    "DISCOVER_PROPERTIES": _discover_properties,
    "DISCOVER_DATASOURCES": _discover_datasources,
    "DBSCHEMA_CATALOGS": _dbschema_catalogs,
    "MDSCHEMA_CUBES": _mdschema_cubes,
    "MDSCHEMA_MEASUREGROUPS": _mdschema_measuregroups,
    "MDSCHEMA_MEASUREGROUP_DIMENSIONS": _mdschema_measuregroup_dimensions,
    "MDSCHEMA_DIMENSIONS": _mdschema_dimensions,
    "MDSCHEMA_HIERARCHIES": _mdschema_hierarchies,
    "MDSCHEMA_LEVELS": _mdschema_levels,
    "MDSCHEMA_MEASURES": _mdschema_measures,
}
