"""ApiError is the one exception the API raises on purpose.

Handlers map it to a stable {code, message, detail} JSON shape. The
validation handler strips pydantic's raw `input` so a failing field
(e.g. a pasted private key) is never echoed back in a response.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, code: str, status: int, message: str, detail: str | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.detail = detail


class AuthExpiredError(ApiError):
    def __init__(self, message: str = "Sign in required"):
        super().__init__("AUTH_EXPIRED", 401, message)


def safe_error_details(errors: list[dict]) -> list[dict]:
    """Strip pydantic's raw `input` value from validation error dicts.

    `.errors()` embeds the submitted value, so serialising it verbatim echoes
    whatever the caller sent back to them in the response body. Callers only
    need the path, the message and the type.
    """
    return [{k: v for k, v in error.items() if k != "input"} for error in errors]


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    def _handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"code": exc.code, "message": exc.message, "detail": exc.detail},
        )

    @app.exception_handler(RequestValidationError)
    def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echo the submitted value back to the caller. Each error
        # dict from FastAPI/pydantic includes the raw `input` for the
        # failing field, which would leak any sensitive field (e.g. a
        # private key) that fails validation straight into the response
        # body. Strip it before rendering.
        safe_errors = safe_error_details(exc.errors())
        return JSONResponse(
            status_code=422,
            content={
                "code": "VALIDATION_ERROR",
                "message": "Request validation failed",
                "detail": str(safe_errors),
            },
        )

    @app.exception_handler(StarletteHTTPException)
    def _handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": "HTTP_ERROR", "message": str(exc.detail), "detail": None},
        )

    @app.exception_handler(Exception)
    def _handle_unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": "INTERNAL_ERROR", "message": "Internal server error", "detail": None},
        )
