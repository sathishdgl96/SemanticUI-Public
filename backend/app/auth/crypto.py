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
