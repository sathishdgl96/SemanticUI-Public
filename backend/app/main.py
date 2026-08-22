"""The application factory: middleware, routers, serving order.

Order is load-bearing. The request-context middleware wraps everything
so every log line and audit row carries a request id; security headers
apply to every response, errors included; compression sits innermost,
where a Content-Length still exists for it to measure; and the SPA mount
registers LAST so it can only claim paths no API route did (its 404
fallback serves the shell page for client-side deep links).
"""

import logging
import secrets
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from starlette.middleware.gzip import GZipMiddleware

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
    from app.logging import RequestTimer, request_id_var, setup_logging, user_id_var

    setup_logging(
        settings.log_format
        or ("json" if settings.environment == "production" else "plain")
    )
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    register_error_handlers(app)
    request_logger = logging.getLogger("app.request")

    # Registered FIRST, which under Starlette's reverse nesting makes it the
    # INNERMOST layer -- and that placement is the whole trick.
    #
    # `@app.middleware("http")` is BaseHTTPMiddleware, which re-emits every
    # response as a stream and drops Content-Length on the way. GZip cannot
    # size a response it cannot measure, so from anywhere outside those two
    # it compresses unconditionally and `minimum_size` silently does
    # nothing -- a 20-byte /healthz comes back gzipped. Innermost, it still
    # sees the route's real Content-Length and can honour the threshold.
    #
    # Why it exists at all: this same server hands out the built SPA, and
    # that bundle is ~2 MB of JavaScript. Uncompressed, the transfer IS the
    # first-load wait on any real connection -- invisible during local
    # development, where there is no network to cross.
    #
    # compresslevel 6, not the default 9: nothing caches the compressed
    # bytes, so every request pays that CPU, and 9 buys very little size
    # over 6. Already-compressed types (png, woff2, zip) are skipped by the
    # middleware's own exclusion list.
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        """Baseline browser protections plus the CSRF posture.

        CSRF: the API is JSON-over-fetch with a SameSite=lax cookie and no
        CORS middleware (cross-origin reads are already dead). The residual
        risk is a cross-site FORM POST, which modern browsers label with
        Sec-Fetch-Site: cross-site -- refused here for unsafe methods.
        Token-authenticated paths (/xmla, /api/feed) carry no cookie and
        need no refusal.
        """
        if (
            request.method in ("POST", "PUT", "PATCH", "DELETE")
            and request.headers.get("sec-fetch-site") == "cross-site"
            and not request.url.path.startswith(("/xmla", "/api/feed"))
        ):
            from fastapi.responses import JSONResponse as _JSON

            return _JSON({"error": "cross-site request refused"}, status_code=403)
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if response.headers.get("content-type", "").startswith("text/html"):
            # The SPA is fully self-hosted; the only reaches outward are an
            # optional external logo (img https:) and nothing else.
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: https:; "
                "style-src 'self' 'unsafe-inline'; connect-src 'self'; "
                "frame-ancestors 'none'",
            )
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        # Three cases, and the order decides them.
        #
        # Vite hashes every asset filename, so an asset is immutable by
        # construction -- a change produces a different name. Saying so lets
        # a returning browser skip the network entirely instead of paying a
        # round-trip per asset to be told 304, which on a high-latency link
        # is several sequential round-trips before anything renders.
        #
        # index.html is the opposite: it NAMES those hashes, so a cached copy
        # pins the app to the build it came from and would boot into 404s
        # after a deploy. It is matched on content type rather than on path,
        # which also catches every deep link the SPA fallback answers with
        # it -- including /assets/typo.js, which must not be cached for a
        # year as though the missing file were real.
        content_type = response.headers.get("content-type", "")
        if request.url.path.startswith(("/api", "/auth")):
            response.headers.setdefault("Cache-Control", "no-store")
        elif content_type.startswith("text/html"):
            response.headers.setdefault("Cache-Control", "no-cache")
        elif request.url.path.startswith("/assets/"):
            response.headers.setdefault(
                "Cache-Control", "public, max-age=31536000, immutable"
            )
        if get_settings().environment == "production":
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        """Correlation and the one summary line per request.

        Honours an inbound X-Request-ID (the reverse proxy usually mints
        one) so app logs join the proxy's; generates one otherwise. The
        id goes back on the response so a user's bug report can name it.
        """
        rid = request.headers.get("X-Request-ID") or secrets.token_hex(8)
        token_rid = request_id_var.set(rid)
        token_uid = user_id_var.set(None)
        timer = RequestTimer()
        try:
            response = await call_next(request)
            request_logger.info(
                "request",
                extra={"method": request.method, "path": request.url.path,
                       "status": response.status_code,
                       "duration_ms": timer.duration_ms},
            )
            response.headers["X-Request-ID"] = rid
            return response
        except Exception:
            request_logger.exception(
                "unhandled",
                extra={"method": request.method, "path": request.url.path,
                       "status": 500, "duration_ms": timer.duration_ms},
            )
            raise
        finally:
            request_id_var.reset(token_rid)
            user_id_var.reset(token_uid)

    @app.get("/api/branding")
    def branding() -> dict:
        """Name and logo for whoever is looking -- the login page needs it
        before anyone is signed in, so this is deliberately public."""
        current = get_settings()
        logo = current.app_logo_url
        if not logo and current.app_logo_file:
            logo = "/api/branding/logo"
        return {
            "name": current.app_name,
            "logoUrl": logo,
            # The sign-in page's own dressing. Empty means the built-in
            # gradient, which is what an unconfigured deployment gets.
            "loginBackgroundUrl": current.login_background(),
            "loginTagline": current.login_tagline,
        }

    @app.get("/api/branding/logo")
    def branding_logo():
        """The SEMANTICUI_APP_LOGO_FILE, served by the app itself: a logo
        that lives on the server's disk without needing a web host."""
        import os

        from fastapi.responses import FileResponse

        from app.errors import ApiError

        path = get_settings().app_logo_file
        if not path or not os.path.isfile(path):
            raise ApiError("HTTP_ERROR", 404, "No logo file is configured.")
        return FileResponse(path)

    @app.get("/api/branding/login-background")
    def branding_login_background():
        """The sign-in backdrop, when it lives on this machine rather than
        behind a URL. Same shape as the logo endpoint, and public for the
        same reason: it is drawn before anybody has signed in."""
        import os

        from fastapi.responses import FileResponse

        from app.errors import ApiError

        path = get_settings().login_background_path()
        if not path or not os.path.isfile(path):
            raise ApiError("HTTP_ERROR", 404, "No sign-in background is configured.")
        return FileResponse(path)

    from app.auth.routes import router as auth_router
    from app.auth.dev import router as dev_router
    from app.explores.routes import router as explores_router
    from app.library.routes import router as library_router
    from app.home.routes import router as home_router
    from app.dashboards.routes import router as dashboards_router
    from app.admin.routes import router as admin_router
    from app.announcements.routes import router as announcements_router
    from app.session.routes import router as session_router
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
    app.include_router(library_router)
    app.include_router(home_router)
    app.include_router(dashboards_router)
    app.include_router(admin_router)
    app.include_router(announcements_router)
    app.include_router(session_router)
    app.include_router(workspaces_router)
    app.include_router(ask_router)
    app.include_router(xmla_router)
    app.include_router(feed_router)
    app.include_router(export_router)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict:
        """Readiness: the app database answers. Cheap deliberately --
        orchestrators call this every few seconds."""
        from sqlalchemy import text

        db = new_session()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
        return {"status": "ok"}

    if settings.static_dir:
        import os

        from fastapi.staticfiles import StaticFiles

        from starlette.exceptions import HTTPException as StarletteHTTPException

        class SpaStaticFiles(StaticFiles):
            async def get_response(self, path: str, scope):
                # A deep link like /reports/123 belongs to the SPA router,
                # so the shell page answers. Starlette signals the miss as
                # an exception OR a 404 response depending on the path
                # shape -- catch both.
                try:
                    response = await super().get_response(path, scope)
                except StarletteHTTPException as exc:
                    if exc.status_code == 404:
                        return await super().get_response("index.html", scope)
                    raise
                if response.status_code == 404:
                    return await super().get_response("index.html", scope)
                return response

        if os.path.isdir(settings.static_dir):
            app.mount(
                "/", SpaStaticFiles(directory=settings.static_dir, html=True)
            )


    return app


app = create_app()
