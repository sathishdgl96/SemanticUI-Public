"""Fernet encryption for at-rest OAuth tokens, keyed from the app secret.

Sessions must survive a process restart, so tokens live in the database
-- but only encrypted under a key derived from SEMANTICUI_SECRET_KEY,
which production refuses to leave at the default.
"""

import base64
import hashlib

from cryptography.fernet import Fernet

from app.config import get_settings


def fernet_from_secret(secret: str) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt_token(plain: str) -> bytes:
    return fernet_from_secret(get_settings().secret_key).encrypt(plain.encode())


def decrypt_token(blob: bytes) -> str:
    return fernet_from_secret(get_settings().secret_key).decrypt(blob).decode()
