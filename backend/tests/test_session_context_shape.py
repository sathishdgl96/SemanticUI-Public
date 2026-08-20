"""The real shape of SHOW GRANTS TO USER, captured from Snowflake.

The first version of this feature read column 0 of that rowset and
assumed it was the role. It is `created_on`, a timestamp -- so every
role was rejected and the switcher was dead. The unit test could not
catch it because its fake declared a single-column cursor: the fake
encoded the same wrong assumption as the code.

These rows are a verbatim capture (account xriieim, 2026-08-20). The
point of this file is that the fixture is not invented.
"""

from app.session import context
from tests.fakes import FakeCol, FakeConnection, FakeCursor

#: Verbatim columns of SHOW GRANTS TO USER.
GRANT_COLUMNS = [
    "created_on", "privilege", "granted_on", "name", "role",
    "granted_to", "grantee_name", "grant_option", "granted_by",
]

#: Verbatim rows: direct privilege grants sit alongside role grants,
#: and only the ones granted_on = ROLE name a role.
GRANT_ROWS = [
    ("2026-08-15 00:45:18", "CREATE SCHEMA", "DATABASE", "USER$SATHISHDGL96",
     None, "USER", "SATHISHDGL96", "false", ""),
    ("2026-08-15 00:45:18", "USAGE", "DATABASE", "USER$SATHISHDGL96",
     None, "USER", "SATHISHDGL96", "true", ""),
    ("2026-08-15 00:44:04", "USAGE", "ROLE", "ACCOUNTADMIN", "ACCOUNTADMIN",
     "USER", "SATHISHDGL96", "false", ""),
    ("2026-08-19 09:31:22", "USAGE", "ROLE", "ANALYST", "ANALYST",
     "USER", "SATHISHDGL96", "false", "ACCOUNTADMIN"),
    ("2026-08-15 00:44:09", "USAGE", "ROLE", "ORGADMIN", "ORGADMIN",
     "USER", "SATHISHDGL96", "false", ""),
    ("2026-08-15 00:45:18", "OWNERSHIP", "SCHEMA", "USER$SATHISHDGL96.LOCAL",
     None, "USER", "SATHISHDGL96", "true", "SATHISHDGL96"),
]

WAREHOUSE_COLUMNS = ["name", "state", "type", "size"]
WAREHOUSE_ROWS = [
    ("COMPUTE_WH", "SUSPENDED", "STANDARD", "X-Small"),
    ("BIG_WH", "STARTED", "STANDARD", "Large"),
]


class SnowflakeShapedCursor(FakeCursor):
    """Answers with the column layouts Snowflake actually returns."""

    def __init__(self):
        super().__init__()
        self.current_role = "SYSADMIN"
        self.current_warehouse = "COMPUTE_WH"

    def execute(self, sql: str, params=None):
        self.executed.append(sql)
        self.bound.append(params)
        upper = sql.upper()
        if upper.startswith("SELECT CURRENT_USER"):
            self.description = [FakeCol("CURRENT_USER()")]
            self.rows = [("SATHISHDGL96",)]
        elif upper.startswith("SELECT CURRENT_ROLE"):
            self.description = [FakeCol("CURRENT_ROLE()"), FakeCol("CURRENT_WAREHOUSE()")]
            self.rows = [(self.current_role, self.current_warehouse)]
        elif upper.startswith("SHOW GRANTS TO USER"):
            self.description = [FakeCol(c) for c in GRANT_COLUMNS]
            self.rows = list(GRANT_ROWS)
        elif upper.startswith("SHOW WAREHOUSES"):
            self.description = [FakeCol(c) for c in WAREHOUSE_COLUMNS]
            self.rows = list(WAREHOUSE_ROWS)
        elif upper.startswith("USE ROLE "):
            self.current_role = sql.split()[-1].strip('"')
            self.description, self.rows = [], []
        elif upper.startswith("USE WAREHOUSE "):
            self.current_warehouse = sql.split()[-1].strip('"')
            self.description, self.rows = [], []
        else:
            self.description, self.rows = [], []
        return self


def conn_with_cursor():
    cursor = SnowflakeShapedCursor()
    return FakeConnection(cursor), cursor


class TestAvailableRoles:
    def test_only_role_grants_count_as_roles(self):
        conn, _ = conn_with_cursor()
        # Not the timestamps in column 0, and not the CREATE SCHEMA /
        # OWNERSHIP rows, which grant privileges rather than a role.
        assert context.available_roles(conn) == ["ACCOUNTADMIN", "ANALYST", "ORGADMIN"]

    def test_it_asks_about_a_named_user_not_a_function(self):
        # SHOW GRANTS TO USER CURRENT_USER() is a SQL compilation error;
        # Snowflake wants an identifier there.
        conn, cursor = conn_with_cursor()
        context.available_roles(conn)
        grants = [s for s in cursor.executed if s.upper().startswith("SHOW GRANTS")]
        assert grants == ['SHOW GRANTS TO USER "SATHISHDGL96"']


class TestAvailableWarehouses:
    def test_it_reads_the_name_column(self):
        conn, _ = conn_with_cursor()
        assert context.available_warehouses(conn) == ["COMPUTE_WH", "BIG_WH"]


class TestCurrentContext:
    def test_it_reports_what_the_connection_is_actually_running_as(self):
        conn, cursor = conn_with_cursor()
        cursor.current_role = "ANALYST"
        assert context.current_context(conn) == {
            "role": "ANALYST",
            "warehouse": "COMPUTE_WH",
        }

    def test_it_follows_an_applied_switch(self):
        conn, _ = conn_with_cursor()
        context.apply_context(conn, "ANALYST", "BIG_WH")
        assert context.current_context(conn) == {
            "role": "ANALYST",
            "warehouse": "BIG_WH",
        }
