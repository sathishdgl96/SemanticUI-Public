"""Load backend/.env before the integration tests read os.environ.

The app itself reads .env through pydantic-settings, but that only populates
`Settings` fields -- it never touches os.environ, and the SEMANTICUI_IT_*
credentials are read straight from os.environ by the modules here. Without
this the whole integration suite would skip on a machine that is, in fact,
fully configured, and a skip reads far too much like a pass.

Real environment variables win: `override=False` means CI (or a one-off
`SEMANTICUI_IT_ACCOUNT=... pytest`) still takes precedence over the file.
"""

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)
