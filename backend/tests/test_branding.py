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


def test_a_background_given_as_a_local_path_is_served_by_the_app(client, db, tmp_path, monkeypatch):
    """"./reporting-bg.jpg" in the url setting is not a mistake worth
    punishing with a blank page -- it is somebody reasonably assuming the
    two branding settings behave alike. The logo already works that way."""
    image = tmp_path / "bg.jpg"
    # Bytes, not a real JPEG: the endpoint serves a file, it does not
    # decode one.
    image.write_bytes(b"not-really-a-jpeg")
    monkeypatch.setattr(get_settings(), "login_background_url", str(image))
    monkeypatch.setattr(get_settings(), "login_background_file", "")

    body = client.get("/api/branding").json()
    assert body["loginBackgroundUrl"] == "/api/branding/login-background"

    served = client.get("/api/branding/login-background")
    assert served.status_code == 200
    assert served.content == b"not-really-a-jpeg"


def test_a_background_given_as_a_url_is_passed_through(client, monkeypatch):
    monkeypatch.setattr(
        get_settings(), "login_background_url", "https://cdn.example/office.jpg"
    )
    assert (
        client.get("/api/branding").json()["loginBackgroundUrl"]
        == "https://cdn.example/office.jpg"
    )


def test_a_background_that_is_not_there_is_no_background(client, monkeypatch):
    """Rather than a URL the browser will ask for and get a 404 from."""
    monkeypatch.setattr(get_settings(), "login_background_url", "./nowhere.jpg")
    monkeypatch.setattr(get_settings(), "login_background_file", "")
    assert client.get("/api/branding").json()["loginBackgroundUrl"] == ""
    assert client.get("/api/branding/login-background").status_code == 404


def test_the_background_endpoint_is_public(client, monkeypatch, tmp_path):
    """It is drawn before anybody has signed in."""
    image = tmp_path / "bg.jpg"
    image.write_bytes(b"x")
    monkeypatch.setattr(get_settings(), "login_background_file", str(image))
    # No session cookie set anywhere in this test.
    assert client.get("/api/branding/login-background").status_code == 200
