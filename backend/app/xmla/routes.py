r"""POST /xmla: the endpoint Excel's MSOLAP provider talks to.

Auth is HTTP Basic, username "account\user" (or account/user), password the
caller's own Snowflake password -- mapped onto the same connection machinery
password dev-login uses, so every Discover and Execute runs as the caller.
TLS is the deployment's business, exactly as it already is for dev-login.

Two deliberate oddities, both learned from the client rather than the spec:

* A malformed response does not error in Excel -- it HANGS it. So handler
  bugs raise and become clean SOAP faults or HTTP errors, never a
  best-effort envelope.
* MSOLAP sends a few Discovers BEFORE BeginSession. Those are served on a
  connection found by credentials digest, so they do not each open a fresh
  Snowflake login.
"""

import base64
import binascii
import logging
import os

from fastapi import APIRouter, Request, Response

from app.errors import ApiError
from app.xmla import discover
from app.xmla.soap import envelope, fault, parse_request
from app.xmla.state import get_store

logger = logging.getLogger(__name__)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("XMLA %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

router = APIRouter()

_UNAUTHORIZED = Response(
    status_code=401,
    # The realm is what Excel shows in its credential prompt.
    headers={"WWW-Authenticate": 'Basic realm="SemanticUI XMLA"'},
    content="Snowflake credentials required",
)


def _credentials(request: Request) -> tuple[str, str] | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    username, sep, password = decoded.partition(":")
    if not sep:
        return None
    return username, password


#: Set SEMANTICUI_XMLA_TRACE to a file path to capture every request and
#: response verbatim. Diagnostic only; contains no credentials (the
#: Authorization header is deliberately not written).
_TRACE = os.environ.get("SEMANTICUI_XMLA_TRACE")


def _trace(direction: str, payload: bytes) -> None:
    if not _TRACE:
        return
    with open(_TRACE, "ab") as f:
        marker = chr(10) + "----- " + direction + " -----" + chr(10)
        f.write(marker.encode())
        f.write(payload)


@router.post("/xmla")
async def xmla(request: Request) -> Response:
    body = await request.body()
    _trace("request", body)
    try:
        xmla_request = parse_request(body)
    except Exception:
        logger.exception("unparseable XMLA request")
        return Response(content=fault("XMLA_PARSE", "unparseable request"),
                        media_type="text/xml")

    store = get_store()
    session = None
    session_id = xmla_request.session_id
    if session_id:
        session = store.get(session_id)

    if session is None:
        credentials = _credentials(request)
        if credentials is None:
            return _UNAUTHORIZED
        try:
            session_id, session = store.open(*credentials)
        except ApiError as exc:
            logger.info("XMLA auth failed: %s", exc.message)
            return _UNAUTHORIZED

    if xmla_request.ends_session:
        store.end(session_id)
        return Response(
            content=envelope("<EndSessionResponse/>"), media_type="text/xml"
        )

    # The Session header goes back on the BeginSession answer and every one
    # after it; MSOLAP quotes it on each subsequent call.
    echo_session = session_id if (xmla_request.wants_session or xmla_request.session_id) else None

    logger.info(
        "%s %s session=%s",
        xmla_request.verb,
        xmla_request.request_type or (xmla_request.statement or "")[:120],
        "yes" if xmla_request.session_id else ("new" if xmla_request.wants_session else "-"),
    )
    try:
        with session.lock:
            if xmla_request.verb == "Discover":
                inner = discover.handle(session, xmla_request)
            else:
                from app.xmla.execute import handle_execute

                inner = handle_execute(session, xmla_request)
    except ApiError as exc:
        return Response(content=fault(exc.code, exc.message), media_type="text/xml")
    except Exception:
        logger.exception(
            "XMLA %s failed (%s)", xmla_request.verb, xmla_request.request_type
        )
        return Response(
            content=fault("XMLA_INTERNAL", "internal error; see server log"),
            media_type="text/xml",
        )

    out = envelope(inner, session_id=echo_session)
    _trace("response", out)
    return Response(
        content=out,
        media_type="text/xml",
        # MSOLAP sends X-Transport-Caps-Negotiation-Flags on every request,
        # offering binary XML and compression. Answering all-zeros is the
        # server saying "plain text only" -- saying NOTHING is a server that
        # never joined the negotiation at all.
        headers={"X-Transport-Caps-Negotiation-Flags": "0,0,0,0,0"},
    )
