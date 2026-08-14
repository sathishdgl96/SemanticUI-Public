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
