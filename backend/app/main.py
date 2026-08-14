import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.errors import register_error_handlers
from app.snowflake.provider import get_cache


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()

    def _sweep_loop() -> None:
        while not stop.wait(60):
            try:
                get_cache().sweep()
            except Exception:
                pass

    thread = threading.Thread(target=_sweep_loop, daemon=True)
    thread.start()
    yield
    stop.set()


def create_app() -> FastAPI:
    get_settings()
    app = FastAPI(title="SemanticUI", lifespan=lifespan)
    register_error_handlers(app)
    from app.auth.routes import router as auth_router
    from app.auth.dev import router as dev_router

    app.include_router(auth_router)
    app.include_router(dev_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
