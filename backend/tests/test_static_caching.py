"""How the built SPA is cached by the browser.

Vite gives every asset a content hash in its filename, so an asset is
immutable by construction: a change produces a different name. Saying so
lets a returning browser skip the network entirely. index.html is the
opposite -- it *names* those hashes, so a cached copy pins the app to the
build it came from, and it must always be revalidated.

Before this, neither carried Cache-Control at all: assets fell back to
revalidation, and every repeat visit paid a round-trip per asset just to be
told 304. On a high-latency link that is several sequential round-trips
before anything renders.
"""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


@pytest.fixture
def spa(tmp_path, monkeypatch):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index-a1b2c3d4.js").write_text("console.log('app')" * 200)
    (assets / "index-e5f6a7b8.css").write_text("body{color:red}" * 200)
    (tmp_path / "index.html").write_text(
        '<!doctype html><html><body><script src="/assets/index-a1b2c3d4.js">'
        "</script></body></html>" + "<!-- pad -->" * 200
    )
    monkeypatch.setenv("SEMANTICUI_STATIC_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


@pytest.mark.parametrize(
    "path", ["/assets/index-a1b2c3d4.js", "/assets/index-e5f6a7b8.css"]
)
def test_hashed_asset_is_cached_forever(spa, path):
    r = spa.get(path)

    assert r.status_code == 200
    cache = r.headers["cache-control"]
    assert "immutable" in cache
    assert "max-age=31536000" in cache
    assert "public" in cache


def test_index_html_is_always_revalidated(spa):
    """A stale index.html points at assets that may no longer exist, so the
    app would boot into 404s after a deploy."""
    r = spa.get("/index.html")

    assert r.status_code == 200
    assert "no-cache" in r.headers["cache-control"]
    assert "immutable" not in r.headers["cache-control"]


def test_deep_link_shell_is_always_revalidated(spa):
    """The SPA fallback returns index.html under another name. It must not
    be cached as though it were the asset the URL looks like."""
    r = spa.get("/reports/some-id")

    assert r.status_code == 200
    assert "no-cache" in r.headers["cache-control"]


def test_api_is_still_never_stored(spa):
    r = spa.get("/api/branding")

    assert r.headers["cache-control"] == "no-store"
