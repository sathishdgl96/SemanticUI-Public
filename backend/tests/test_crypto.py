import pytest
from cryptography.fernet import InvalidToken

from app.auth.crypto import decrypt_token, encrypt_token, fernet_from_secret


def test_round_trip():
    blob = encrypt_token("my-access-token")
    assert isinstance(blob, bytes)
    assert b"my-access-token" not in blob
    assert decrypt_token(blob) == "my-access-token"


def test_wrong_key_fails():
    blob = fernet_from_secret("key-a").encrypt(b"secret")
    with pytest.raises(InvalidToken):
        fernet_from_secret("key-b").decrypt(blob)
