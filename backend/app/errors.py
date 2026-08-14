from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


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


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    def _handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"code": exc.code, "message": exc.message, "detail": exc.detail},
        )
