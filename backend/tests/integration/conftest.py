"""Load backend/.env before the integration tests read os.environ.

The app itself reads .env through pydantic-settings, but that only populates
`Settings` fields -- it never touches os.environ, and the SEMANTICUI_IT_*
credentials are read straight from os.environ by the modules here. Without
this the whole integration suite would skip on a machine that is, in fact,
fully configured, and a skip reads far too much like a pass.

Only the SEMANTICUI_IT_* keys are exported. A blanket `load_dotenv` would
also push SEMANTICUI_SECRET_KEY, AUTH_MODE and DATABASE_URL into the
environment of every *unit* test in the same session -- conftest module code
runs at import, not per-directory -- which silently changes what those tests
are testing. (It did: it broke test_config's default-secret-key case.)

Real environment variables win: an existing value is never overwritten, so
CI or a one-off `SEMANTICUI_IT_ACCOUNT=... pytest` still takes precedence.
"""

import os
from pathlib import Path

from dotenv import dotenv_values

for key, value in dotenv_values(Path(__file__).resolve().parents[2] / ".env").items():
    if key.startswith("SEMANTICUI_IT_") and value is not None:
        os.environ.setdefault(key, value)
