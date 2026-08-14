from typing import Any

from app.errors import ApiError
from app.snowflake.gateway import map_snowflake_error


def quote_ident(name: str) -> str:
    if not name or '"' in name:
        raise ApiError("QUERY_ERROR", 400, f"Invalid identifier: {name!r}")
    return f'"{name}"'


def _execute_dicts(conn: Any, sql: str) -> list[dict]:
    cur = conn.cursor()
    try:
        try:
            cur.execute(sql)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
        names = [d.name.lower() for d in (cur.description or [])]
        return [dict(zip(names, row)) for row in cur.fetchall()]
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
        }
        for row in _execute_dicts(conn, sql)
    ]


_FIELD_KINDS = {"DIMENSION": "dimensions", "METRIC": "metrics", "FACT": "facts"}


def describe_semantic_view(conn: Any, database: str, schema: str, name: str) -> dict:
    fqn = f"{quote_ident(database)}.{quote_ident(schema)}.{quote_ident(name)}"
    rows = _execute_dicts(conn, f"DESCRIBE SEMANTIC VIEW {fqn}")

    tables: list[dict] = []
    relationships: list[str] = []
    fields: dict[tuple[str, str, str], dict] = {}

    for row in rows:
        kind = (row.get("object_kind") or "").upper()
        obj_name = row.get("object_name")
        parent = row.get("parent_entity")
        if kind == "TABLE" and obj_name:
            if not any(t["name"] == obj_name for t in tables):
                tables.append({"name": obj_name})
        elif kind == "RELATIONSHIP" and obj_name:
            if obj_name not in relationships:
                relationships.append(obj_name)
        elif kind in _FIELD_KINDS and obj_name:
            key = (kind, parent or "", obj_name)
            field = fields.setdefault(
                key, {"table": parent, "name": obj_name, "dataType": None}
            )
            if (row.get("property") or "").upper() == "DATA_TYPE":
                field["dataType"] = row.get("property_value")

    detail: dict = {
        "tables": tables,
        "relationships": relationships,
        "dimensions": [],
        "metrics": [],
        "facts": [],
    }
    for (kind, _parent, _name), field in fields.items():
        detail[_FIELD_KINDS[kind]].append(field)
    return detail
