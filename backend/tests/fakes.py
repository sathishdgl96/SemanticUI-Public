from dataclasses import dataclass, field
from typing import Any


@dataclass
class FakeCol:
    name: str
    type_code: int = 2


@dataclass
class FakeCursor:
    rows: list[tuple] = field(default_factory=list)
    description: list[FakeCol] = field(default_factory=list)
    sfqid: str = "q-1"
    error: Exception | None = None
    executed: list[str] = field(default_factory=list)

    def execute(self, sql: str) -> "FakeCursor":
        self.executed.append(sql)
        if self.error is not None:
            raise self.error
        return self

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchmany(self, n: int):
        return self.rows[:n]

    def fetchall(self):
        return list(self.rows)

    def close(self) -> None:
        pass


class FakeConnection:
    def __init__(self, cursor: FakeCursor | None = None):
        self._cursor = cursor or FakeCursor()
        self.closed = False

    def cursor(self) -> FakeCursor:
        return self._cursor

    def is_closed(self) -> bool:
        return self.closed

    def close(self) -> None:
        self.closed = True
