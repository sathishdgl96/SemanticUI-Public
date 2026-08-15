import pytest
import snowflake.connector
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.errors import ApiError
from app.snowflake import connect as sf_connect


def test_connect_oauth_passes_token_and_timeout(monkeypatch):
    seen = {}

    def fake_connect(**kwargs):
        seen.update(kwargs)
        return "CONN"

    monkeypatch.setenv("SEMANTICUI_SNOWFLAKE_ACCOUNT", "myorg-myaccount")
    from app.config import get_settings
    get_settings.cache_clear()
    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    conn = sf_connect.connect_oauth("tok-123")
    get_settings.cache_clear()

    assert conn == "CONN"
    assert seen["account"] == "myorg-myaccount"
    assert seen["authenticator"] == "oauth"
    assert seen["token"] == "tok-123"
    assert seen["session_parameters"]["STATEMENT_TIMEOUT_IN_SECONDS"] == 60


def test_connect_dev_externalbrowser_and_password(monkeypatch):
    calls = []

    def fake_connect(**kwargs):
        calls.append(kwargs)
        return "CONN"

    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    sf_connect.connect_dev(account="acct", user="alice", authenticator="externalbrowser")
    sf_connect.connect_dev(
        account="acct", user="alice", authenticator="password", password="pw"
    )
    assert calls[0]["authenticator"] == "externalbrowser"
    assert "password" not in calls[0]
    assert calls[1]["password"] == "pw"
    assert "authenticator" not in calls[1]


class FakeIdentityCursor:
    def execute(self, sql):
        assert "CURRENT_ACCOUNT()" in sql and "CURRENT_USER()" in sql
        return self

    def fetchone(self):
        return ("ACME", "ALICE")

    def close(self):
        pass


class FakeIdentityConn:
    def cursor(self):
        return FakeIdentityCursor()


def test_probe_identity():
    assert sf_connect.probe_identity(FakeIdentityConn()) == ("ACME", "ALICE")


def _make_pem(passphrase: bytes | None = None) -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    enc = (
        serialization.BestAvailableEncryption(passphrase)
        if passphrase
        else serialization.NoEncryption()
    )
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=enc,
    ).decode()


def test_load_private_key_plain_and_encrypted():
    der = sf_connect.load_private_key(_make_pem(), None)
    assert isinstance(der, bytes) and len(der) > 100
    der2 = sf_connect.load_private_key(_make_pem(b"s3cret"), "s3cret")
    assert isinstance(der2, bytes)


def test_load_private_key_errors_do_not_leak_key_material():
    pem = _make_pem(b"s3cret")
    with pytest.raises(ApiError) as exc_info:
        sf_connect.load_private_key(pem, "wrong-passphrase")
    err = exc_info.value
    assert err.code == "AUTH_FAILED"
    assert "PRIVATE KEY" not in str(err.message)
    assert "PRIVATE KEY" not in str(err.detail or "")

    with pytest.raises(ApiError) as exc_info:
        sf_connect.load_private_key("not-a-pem-at-all", None)
    assert exc_info.value.code == "AUTH_FAILED"


def test_connect_dev_keypair_passes_der(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        snowflake.connector, "connect", lambda **kw: seen.update(kw) or "CONN"
    )
    pem = _make_pem()
    sf_connect.connect_dev(
        account="acct", user="alice", authenticator="keypair", private_key_pem=pem
    )
    assert seen["private_key"] == sf_connect.load_private_key(pem, None)
    assert "password" not in seen
    assert "authenticator" not in seen
    assert seen["session_parameters"]["STATEMENT_TIMEOUT_IN_SECONDS"] == 60


# --- account identifier normalisation -------------------------------------
# Users routinely paste the Snowflake console URL or the full hostname into an
# "Account" field. The connector re-appends ".snowflakecomputing.com", so the
# hostname form fails with an opaque 250001 "could not connect"; the URL form
# fails with 251001. Both are recoverable without guessing at the user's intent.


def test_normalize_account_strips_hostname_suffix():
    assert (
        sf_connect.normalize_account("xriieim-eh01350.snowflakecomputing.com")
        == "xriieim-eh01350"
    )
    assert (
        sf_connect.normalize_account("XRIIEIM-EH01350.SnowflakeComputing.COM")
        == "XRIIEIM-EH01350"
    )


def test_normalize_account_strips_scheme_and_path():
    assert (
        sf_connect.normalize_account("https://xriieim-eh01350.snowflakecomputing.com/")
        == "xriieim-eh01350"
    )
    assert (
        sf_connect.normalize_account("http://xriieim-eh01350.snowflakecomputing.com/x/y")
        == "xriieim-eh01350"
    )


def test_normalize_account_preserves_legacy_region_locators():
    # Legacy locators legitimately contain dots and must survive untouched.
    assert sf_connect.normalize_account("xy12345.us-east-1") == "xy12345.us-east-1"
    assert (
        sf_connect.normalize_account("xy12345.central-india.azure")
        == "xy12345.central-india.azure"
    )


def test_normalize_account_trims_whitespace_and_is_idempotent():
    assert sf_connect.normalize_account("  xriieim-eh01350  ") == "xriieim-eh01350"
    once = sf_connect.normalize_account("xriieim-eh01350.snowflakecomputing.com")
    assert sf_connect.normalize_account(once) == once


def test_connect_dev_normalizes_the_account_before_connecting(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        snowflake.connector, "connect", lambda **kw: seen.update(kw) or "CONN"
    )
    sf_connect.connect_dev(
        account="https://xriieim-eh01350.snowflakecomputing.com/",
        user="alice",
        authenticator="externalbrowser",
    )
    assert seen["account"] == "xriieim-eh01350"
