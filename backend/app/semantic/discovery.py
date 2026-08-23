"""SHOW / DESCRIBE SEMANTIC VIEW, parsed into plain dicts.

These statement kinds cannot take bound parameters, so identifiers go
through quote_ident (which refuses embedded quotes) and results are
row-capped like any other query.
"""

from typing import Any

from app.config import get_settings
from app.errors import ApiError
from app.snowflake.gateway import map_snowflake_error


def quote_ident(name: str) -> str:
    if not name or '"' in name:
        raise ApiError("QUERY_ERROR", 400, f"Invalid identifier: {name!r}")
    return f'"{name}"'


def execute_dicts(conn: Any, sql: str, params: Any = None) -> list[dict]:
    """A statement's rows as dicts, row-capped, with errors mapped.

    Public because source freshness reads INFORMATION_SCHEMA through the same
    cap and the same error mapping; duplicating either there would mean one of
    the two eventually drifting. `params` is for that caller -- SHOW and
    DESCRIBE cannot take bindings, which is why the module docstring says
    identifiers go through quote_ident instead.
    """
    cur = conn.cursor()
    try:
        try:
            if params is None:
                cur.execute(sql)
            else:
                cur.execute(sql, params)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
        names = [d.name.lower() for d in (cur.description or [])]
        # SHOW/DESCRIBE statements went through fetchall() with no cap,
        # bypassing the gateway's row_cap entirely for this statement
        # kind. Bound it the same way run_query() bounds regular queries.
        rows = cur.fetchmany(get_settings().row_cap)
        return [dict(zip(names, row)) for row in rows]
    finally:
        cur.close()


def list_semantic_views(
    conn: Any, database: str | None = None, schema: str | None = None
) -> list[dict]:
    if database and schema:
        sql = f"SHOW SEMANTIC VIEWS IN SCHEMA {quote_ident(database)}.{quote_ident(schema)}"
    elif database:
        sql = f"SHOW SEMANTIC VIEWS IN DATABASE {quote_ident(database)}"
    else:
        sql = "SHOW SEMANTIC VIEWS IN ACCOUNT"
    return [
        {
            "name": row.get("name"),
            "database": row.get("database_name"),
            "schema": row.get("schema_name"),
            "comment": row.get("comment"),
            # Who owns the view, and whether that owner is an account role or
            # a database role -- the two need different questions asked of
            # Snowflake before anybody may certify the model. Absent on the
            # TERSE form and on older accounts, and absent must read as
            # "unknown": an empty role name handed to IS_ROLE_IN_SESSION
            # would be a question with a misleading answer.
            "owner": row.get("owner") or None,
            "ownerRoleType": row.get("owner_role_type") or None,
        }
        for row in execute_dicts(conn, sql)
    ]


_FIELD_KINDS = {"DIMENSION": "dimensions", "METRIC": "metrics", "FACT": "facts"}


def _key_list(value: Any) -> list[str]:
    """The join columns Snowflake reports, as a JSON array of names.

    Unreadable input yields no columns rather than raising: the
    relationship itself still exists and still constrains the join graph,
    and losing the whole describe over a key list would be a far worse
    trade than losing the column names.
    """
    import json

    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if item]


def describe_semantic_view(conn: Any, database: str, schema: str, name: str) -> dict:
    fqn = f"{quote_ident(database)}.{quote_ident(schema)}.{quote_ident(name)}"
    rows = execute_dicts(conn, f"DESCRIBE SEMANTIC VIEW {fqn}")

    tables: dict[str, dict] = {}
    relationships: dict[str, dict] = {}
    fields: dict[tuple[str, str, str], dict] = {}
    hierarchies: dict[tuple[str, str], dict] = {}

    for row in rows:
        kind = (row.get("object_kind") or "").upper()
        obj_name = row.get("object_name")
        parent = row.get("parent_entity")
        prop = (row.get("property") or "").upper()
        if kind == "TABLE" and obj_name:
            # `object_name` is what the model calls the table; the BASE_TABLE_*
            # properties say which physical table it reads. Source freshness
            # has to ask INFORMATION_SCHEMA about the latter, so both are kept.
            # A logical table defined by a SQL query carries DEFINITION and no
            # base table at all -- recorded rather than guessed at, because
            # "derived from a query" is a truthful answer and a fabricated
            # source table is not.
            entry = tables.setdefault(
                obj_name,
                {
                    "name": obj_name,
                    "baseDatabase": None,
                    "baseSchema": None,
                    "baseTable": None,
                    "queryBacked": False,
                },
            )
            if prop == "BASE_TABLE_DATABASE_NAME":
                entry["baseDatabase"] = row.get("property_value")
            elif prop == "BASE_TABLE_SCHEMA_NAME":
                entry["baseSchema"] = row.get("property_value")
            elif prop == "BASE_TABLE_NAME":
                entry["baseTable"] = row.get("property_value")
            elif prop == "DEFINITION":
                entry["queryBacked"] = True
        elif kind == "RELATIONSHIP" and obj_name:
            # `TABLE` is the foreign-key side, `REF_TABLE` the primary-key
            # side, so the pair is directed: it always points from finer grain
            # to coarser. That direction is what app.semantic.joins reasons
            # over, and dropping it (as this parser used to) is why an
            # unanswerable field combination could only be discovered by
            # sending it to Snowflake and reading the error.
            entry = relationships.setdefault(
                obj_name,
                {
                    "name": obj_name,
                    "table": parent,
                    "refTable": None,
                    "foreignKey": [],
                    "refKey": [],
                },
            )
            if prop == "TABLE":
                entry["table"] = row.get("property_value")
            elif prop == "REF_TABLE":
                entry["refTable"] = row.get("property_value")
            elif prop == "FOREIGN_KEY":
                entry["foreignKey"] = _key_list(row.get("property_value"))
            elif prop == "REF_KEY":
                entry["refKey"] = _key_list(row.get("property_value"))
        elif kind == "HIERARCHY" and obj_name:
            # Collected verbatim; detect_hierarchies below decides what, if
            # anything, is usable. No account seen so far emits these rows.
            entry = hierarchies.setdefault(
                (parent or "", obj_name),
                {"table": parent or "", "name": obj_name, "levels": None},
            )
            if (row.get("property") or "").upper() == "LEVELS":
                entry["levels"] = row.get("property_value")
        elif kind in _FIELD_KINDS and obj_name:
            key = (kind, parent or "", obj_name)
            field = fields.setdefault(
                key, {"table": parent, "name": obj_name, "dataType": None}
            )
            if (row.get("property") or "").upper() == "DATA_TYPE":
                field["dataType"] = row.get("property_value")

    detail: dict = {
        "tables": list(tables.values()),
        "relationships": list(relationships.values()),
        "dimensions": [],
        "metrics": [],
        "facts": [],
        "hierarchies": list(hierarchies.values()),
    }
    for (kind, _parent, _name), field in fields.items():
        detail[_FIELD_KINDS[kind]].append(field)
    return detail


def detect_hierarchies(detail: dict) -> list[dict]:
    """Hierarchies the semantic model itself declares, or [] if it declares none.

    Snowflake does not expose hierarchies in DESCRIBE SEMANTIC VIEW on the
    accounts this was built against, so today this returns [] and the
    report-defined path is what works. It ships anyway so the model-first path
    activates on its own the day an account does expose them, rather than
    needing a code change at that point.
    """
    found: list[dict] = []
    for raw in detail.get("hierarchies", []):
        table = (raw.get("table") or "").strip()
        levels = [
            f"{table}.{part.strip()}" if table else part.strip()
            for part in (raw.get("levels") or "").split(",")
            if part.strip()
        ]
        # Two levels minimum, the same rule report-defined hierarchies obey:
        # a one-level hierarchy is a plain field, and offering it as drillable
        # would promise a drill that immediately dead-ends.
        if len(levels) < 2:
            continue
        found.append(
            {
                # Namespaced, so a model hierarchy can never collide with a
                # report-defined id.
                "id": f"model:{table}.{raw['name']}" if table else f"model:{raw['name']}",
                "name": raw["name"],
                "levels": levels,
            }
        )
    return found
