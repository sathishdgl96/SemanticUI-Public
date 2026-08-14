from fastapi.testclient import TestClient

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
