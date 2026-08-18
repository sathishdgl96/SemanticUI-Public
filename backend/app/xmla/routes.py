r"""POST /xmla: the endpoint Excel's MSOLAP provider talks to.

Auth is HTTP Basic carrying a CONNECT TOKEN in the password field (the
username is ignored -- Excel requires one, "token" reads well). The token
was minted by the signed-in app UI and resolves to that app session: its
user, its workspace rights, its cached Snowflake connection. The adapter
never opens Snowflake connections of its own. TLS is the deployment's
business, exactly as it already is for the rest of the API.

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

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.db.base import get_db
from app.errors import ApiError
from app.xmla import discover
from app.xmla.soap import envelope, fault, parse_request
from app.xmla.state import acquire_entry, get_store

logger = logging.getLogger(__name__)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("XMLA %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

router = APIRouter()

#: [MS-SSAS] content-type negotiation: NEGO, REQ_SX, REQ_XPRESS, RESP_SX,
#: RESP_XPRESS. This server speaks plain text/xml both ways, so every
#: capability bit is 0 and NEGO=1 declares the negotiation settled. The spec
#: is unambiguous that the flags go on EVERY response -- the 401 challenge
#: and faults included, which the first build omitted.
_NEGOTIATION = {"X-Transport-Caps-Negotiation-Flags": "1,0,0,0,0"}


def _unauthorized() -> Response:
    from app.config import get_settings

    return Response(
        status_code=401,
        # The realm is what Excel shows in its credential prompt.
        headers={
            "WWW-Authenticate": f'Basic realm="{get_settings().app_name} XMLA"',
            **_NEGOTIATION,
        },
        content="Connect token required (Basic auth, token as the password)",
    )


def _token(request: Request) -> str | None:
    """The connect token out of Basic auth; the username half is ignored."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    _, sep, password = decoded.partition(":")
    if not sep:
        return None
    return password


#: Set SEMANTICUI_XMLA_TRACE to a file path to capture every request and
#: response verbatim. Diagnostic only; contains no credentials (the
#: Authorization header is deliberately not written).
_TRACE = os.environ.get("SEMANTICUI_XMLA_TRACE")


def _trace(direction: str, payload, headers=None) -> None:
    if not _TRACE:
        return
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    with open(_TRACE, "ab") as f:
        marker = chr(10) + "----- " + direction + " -----" + chr(10)
        f.write(marker.encode())
        if headers is not None:
            for name, value in headers:
                if name.lower() == "authorization":
                    value = "<redacted>"
                f.write(f"{name}: {value}".encode() + b"\r\n")
            f.write(b"\r\n")
        f.write(payload)


@router.post("/xmla")
async def xmla(request: Request, db: Session = Depends(get_db)) -> Response:
    body = await request.body()
    _trace("request", body, headers=request.headers.items())
    try:
        xmla_request = parse_request(body)
    except Exception:
        logger.exception("unparseable XMLA request")
        out = fault("XMLA_PARSE", "unparseable request")
        _trace("response", out)
        return Response(content=out, media_type="text/xml", headers=_NEGOTIATION)

    store = get_store()
    session = None
    session_id = xmla_request.session_id
    if session_id:
        session = store.get(session_id)

    if session is None:
        token = _token(request)
        if token is None:
            return _unauthorized()
        try:
            session_id, session = store.open(db, token)
        except ApiError as exc:
            logger.info("XMLA auth failed: %s", exc.message)
            return _unauthorized()

    if xmla_request.ends_session:
        store.end(session_id)
        return Response(
            content=envelope("<EndSessionResponse/>"),
            media_type="text/xml",
            headers=_NEGOTIATION,
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
        entry = acquire_entry(db, session)
        with entry.lock:
            session.bind(entry)
            if xmla_request.verb == "Discover":
                inner = discover.handle(session, xmla_request)
            else:
                from app.xmla.execute import handle_execute

                inner = handle_execute(session, xmla_request)
    except ApiError as exc:
        out = fault(exc.code, exc.message)
        _trace("response", out)
        return Response(content=out, media_type="text/xml", headers=_NEGOTIATION)
    except Exception:
        logger.exception(
            "XMLA %s failed (%s)", xmla_request.verb, xmla_request.request_type
        )
        return Response(
            content=fault("XMLA_INTERNAL", "internal error; see server log"),
            media_type="text/xml",
            headers=_NEGOTIATION,
        )

    out = envelope(inner, session_id=echo_session)
    headers = dict(_NEGOTIATION)
    if echo_session:
        # [MS-SSAS] 2.2.2: the session id also travels as an HTTP header,
        # "retrieved from the response to the BeginSession request".
        headers["X-AS-SessionID"] = echo_session
    _trace("response", out, headers=sorted(headers.items()))
    return Response(content=out, media_type="text/xml", headers=headers)
