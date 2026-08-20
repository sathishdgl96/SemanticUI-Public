"""One env var rebrands every surface that says the product's name."""

from app.config import get_settings
from app.xmla import discover
from app.xmla.soap import parse_request


def test_branding_endpoint_is_public_and_reads_settings(client, monkeypatch):
    # Patched to KNOWN values rather than asserting the defaults: the suite
    # honours the developer's own .env, which may already be branded.
    monkeypatch.setattr(get_settings(), "app_name", "PlainBI")
    monkeypatch.setattr(get_settings(), "app_logo_url", None)
    monkeypatch.setattr(get_settings(), "app_logo_file", None)
    assert client.get("/api/branding").json() == {
        "name": "PlainBI",
        "logoUrl": None,
        # The sign-in page's own dressing travels with the rest of the
        # branding: empty means the built-in gradient and no tagline.
        "loginBackgroundUrl": "",
        "loginTagline": "",
    }

    monkeypatch.setattr(get_settings(), "app_name", "AcmeBI")
    monkeypatch.setattr(get_settings(), "app_logo_url", "https://acme.example/logo.svg")
    assert client.get("/api/branding").json() == {
        "name": "AcmeBI",
        "logoUrl": "https://acme.example/logo.svg",
        "loginBackgroundUrl": "",
        "loginTagline": "",
    }


def test_the_xmla_catalog_follows_the_app_name(monkeypatch):
    monkeypatch.setattr(get_settings(), "app_name", "AcmeBI")
    body = (
        b'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
        b'<soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis">'
        b"<RequestType>DBSCHEMA_CATALOGS</RequestType>"
        b"<Restrictions/><Properties/></Discover></soap:Body></soap:Envelope>"
    )
    xml = discover.handle(None, parse_request(body))
    assert "<CATALOG_NAME>AcmeBI</CATALOG_NAME>" in xml
    assert "SemanticUI" not in xml


def test_a_logo_file_on_disk_is_served_by_the_app(client, monkeypatch, tmp_path):
    logo = tmp_path / "logo.png"
    logo.write_bytes(b"\x89PNG fake image bytes")
    monkeypatch.setattr(get_settings(), "app_logo_url", None)
    monkeypatch.setattr(get_settings(), "app_logo_file", str(logo))

    body = client.get("/api/branding").json()
    assert body["logoUrl"] == "/api/branding/logo"

    served = client.get("/api/branding/logo")
    assert served.status_code == 200
    assert served.content == b"\x89PNG fake image bytes"
    assert served.headers["content-type"] == "image/png"


def test_an_explicit_url_wins_over_the_file(client, monkeypatch, tmp_path):
    logo = tmp_path / "logo.svg"
    logo.write_text("<svg/>")
    monkeypatch.setattr(get_settings(), "app_logo_file", str(logo))
    monkeypatch.setattr(get_settings(), "app_logo_url", "https://cdn.example/x.svg")
    assert client.get("/api/branding").json()["logoUrl"] == "https://cdn.example/x.svg"


def test_no_logo_file_is_a_clean_404(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "app_logo_file", None)
    assert client.get("/api/branding/logo").status_code == 404
