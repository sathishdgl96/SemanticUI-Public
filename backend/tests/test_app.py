import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import get_settings
from app.errors import ApiError
from app.main import create_app


def test_healthz():
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_api_error_rendered_as_envelope():
    app = create_app()

    @app.get("/boom")
    def boom():
        raise ApiError("QUERY_ERROR", 400, "bad query", detail="line 1")

    with TestClient(app) as client:
        r = client.get("/boom")
    assert r.status_code == 400
    assert r.json() == {"code": "QUERY_ERROR", "message": "bad query", "detail": "line 1"}


def test_404_rendered_as_envelope():
    app = create_app()

    with TestClient(app) as client:
        r = client.get("/does-not-exist")
    assert r.status_code == 404
    assert r.json() == {"code": "HTTP_ERROR", "message": "Not Found", "detail": None}


def test_validation_error_rendered_as_envelope():
    app = create_app()

    @app.get("/typed")
    def typed(n: int):
        return {"n": n}

    with TestClient(app) as client:
        r = client.get("/typed", params={"n": "not-a-number"})
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "VALIDATION_ERROR"
    assert body["message"] == "Request validation failed"
    assert isinstance(body["detail"], str)


def test_create_app_fails_fast_on_invalid_settings(monkeypatch):
    monkeypatch.setenv("SEMANTICUI_AUTH_MODE", "dev")
    monkeypatch.setenv("SEMANTICUI_ENVIRONMENT", "production")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValidationError):
            create_app()
    finally:
        get_settings.cache_clear()


def test_large_response_is_gzipped():
    """The built SPA ships ~2 MB of JS from this same server. Uncompressed,
    that transfer *is* the first-load wait on any real network -- local
    development never sees it because there is no network to see."""
    app = create_app()

    @app.get("/big")
    def big():
        return {"rows": ["x" * 100] * 200}

    with TestClient(app) as client:
        r = client.get("/big", headers={"accept-encoding": "gzip"})

    assert r.headers.get("content-encoding") == "gzip"
    assert r.json()["rows"][0] == "x" * 100


def test_small_response_is_left_alone():
    """Compressing a 30-byte health check costs CPU and saves nothing."""
    app = create_app()

    with TestClient(app) as client:
        r = client.get("/healthz", headers={"accept-encoding": "gzip"})

    assert r.headers.get("content-encoding") is None
    assert r.json() == {"status": "ok"}


def test_client_that_cannot_gunzip_still_gets_its_answer():
    app = create_app()

    @app.get("/big")
    def big():
        return {"rows": ["x" * 100] * 200}

    with TestClient(app) as client:
        r = client.get("/big", headers={"accept-encoding": "identity"})

    assert r.headers.get("content-encoding") is None
    assert r.json()["rows"][0] == "x" * 100
