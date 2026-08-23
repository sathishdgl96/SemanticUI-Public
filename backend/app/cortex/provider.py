"""The seam between this product and a language model.

Cortex is a SQL function, so the call runs on the CALLER'S OWN connection --
authorized by their Snowflake role, billed to their compute. There is no
server-side API key anywhere in this design, and no data leaves Snowflake.

The rest of the sub-project is testable through `FakeProvider`, which matters
more than usual here: Cortex is unavailable on the development account, so the
live path cannot be exercised at all.
"""

from typing import Any, Protocol

from snowflake.connector.errors import Error as SnowflakeError

from app.config import get_settings
from app.errors import ApiError

#: Snowflake's errno for "this account has no Cortex". The development account
#: returns exactly this.
CORTEX_UNAVAILABLE_ERRNO = 399258

#: Fallback signal, in case the errno ever changes.
_UNAVAILABLE_TEXT = "not available for trial accounts"


class LlmProvider(Protocol):
    def complete(self, conn: Any, prompt: str) -> str: ...


def _map_error(exc: Exception) -> ApiError:
    errno = getattr(exc, "errno", None)
    message = getattr(exc, "raw_msg", None) or getattr(exc, "msg", None) or str(exc)
    if errno == CORTEX_UNAVAILABLE_ERRNO or _UNAVAILABLE_TEXT in message.lower():
        # Snowflake's own words, so the user learns WHY rather than seeing a
        # generic failure they cannot act on.
        return ApiError(
            "CORTEX_UNAVAILABLE",
            503,
            f"Snowflake Cortex is not available on this account: {message}",
        )
    if isinstance(exc, SnowflakeError):
        return ApiError("ASK_FAILED", 502, message)
    return ApiError("ASK_FAILED", 502, str(exc))


class CortexProvider:
    def __init__(self, model: str):
        self.model = model

    def complete(self, conn: Any, prompt: str) -> str:
        """Ask the model, on the caller's own connection.

        The prompt embeds a user's question, so it is BOUND rather than
        interpolated -- a question containing a quote would otherwise be a
        syntax error, and worse things than that.
        """
        cur = conn.cursor()
        try:
            try:
                cur.execute(
                    "SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?)", [self.model, prompt]
                )
            except Exception as exc:
                raise _map_error(exc) from exc
            row = cur.fetchone()
            if not row or row[0] is None:
                raise ApiError(
                    "ASK_FAILED", 502, "The model returned no answer. Try again."
                )
            return str(row[0])
        finally:
            cur.close()


class FakeProvider:
    """Drives every test in this sub-project. Records what it was asked."""

    def __init__(self, reply: str = "", error: Exception | None = None):
        self.reply = reply
        self.error = error
        self.prompts: list[str] = []

    def complete(self, conn: Any, prompt: str) -> str:
        self.prompts.append(prompt)
        if self.error is not None:
            raise self.error
        return self.reply


def get_provider() -> LlmProvider:
    return CortexProvider(get_settings().cortex_model)
