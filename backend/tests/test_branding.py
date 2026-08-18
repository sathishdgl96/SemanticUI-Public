"""One env var rebrands every surface that says the product's name."""

from app.config import get_settings
from app.xmla import discover
from app.xmla.soap import parse_request


def test_branding_endpoint_is_public_and_reads_settings(client, monkeypatch):
    response = client.get("/api/branding")
    assert response.status_code == 200
    assert response.json() == {"name": "SemanticUI", "logoUrl": None}

    monkeypatch.setattr(get_settings(), "app_name", "AcmeBI")
    monkeypatch.setattr(get_settings(), "app_logo_url", "https://acme.example/logo.svg")
    assert client.get("/api/branding").json() == {
        "name": "AcmeBI",
        "logoUrl": "https://acme.example/logo.svg",
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
