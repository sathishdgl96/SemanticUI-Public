import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.auth.sessions import purge_expired_sessions
from app.config import get_settings
from app.db.base import new_session
from app.errors import register_error_handlers
from app.snowflake.provider import get_cache

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()

    def _sweep_loop() -> None:
        while not stop.wait(60):
            try:
                get_cache().sweep()
                db = new_session()
                try:
                    purge_expired_sessions(db)
                finally:
                    db.close()
            except Exception:
                # A permanently failing sweeper (e.g. Postgres down) must
                # not fail silently -- log it, but keep the loop alive so
                # it can recover once the underlying issue clears.
                logger.exception("background sweeper iteration failed")

    thread = threading.Thread(target=_sweep_loop, daemon=True)
    thread.start()
    yield
    stop.set()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    register_error_handlers(app)

    @app.get("/api/branding")
    def branding() -> dict:
        """Name and logo for whoever is looking -- the login page needs it
        before anyone is signed in, so this is deliberately public."""
        current = get_settings()
        return {"name": current.app_name, "logoUrl": current.app_logo_url}

    from app.auth.routes import router as auth_router
    from app.auth.dev import router as dev_router
    from app.explores.routes import router as explores_router
    from app.reports.routes import router as reports_router
    from app.workspaces.routes import router as workspaces_router
    from app.cortex.routes import router as ask_router
    from app.export.routes import router as export_router
    from app.semantic.routes import router as semantic_router
    from app.xmla.routes import router as xmla_router
    from app.feed.routes import router as feed_router

    app.include_router(auth_router)
    app.include_router(dev_router)
    app.include_router(semantic_router)
    app.include_router(reports_router)
    app.include_router(explores_router)
    app.include_router(workspaces_router)
    app.include_router(ask_router)
    app.include_router(xmla_router)
    app.include_router(feed_router)
    app.include_router(export_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
