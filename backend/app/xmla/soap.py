"""The SOAP shape of XMLA: parse what MSOLAP sends, build what it reads.

Kept deliberately dumb -- element extraction and envelope assembly, no
knowledge of any particular rowset. The provider is intolerant in a specific
way that shapes everything here: a malformed response does not error, it
HANGS the client (observed against Excel's own MSOLAP 17 before any of this
was written). So this module prefers raising loudly server-side over emitting
something plausible-looking, because a 500 surfaces in the log while a bad
envelope surfaces as a user staring at a frozen Excel.
"""

from xml.etree import ElementTree

SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"
XMLA_NS = "urn:schemas-microsoft-com:xml-analysis"
ROWSET_NS = "urn:schemas-microsoft-com:xml-analysis:rowset"
MDDATASET_NS = "urn:schemas-microsoft-com:xml-analysis:mddataset"
#: MSOLAP sends engine headers (Version, Session) in this namespace family.
ENGINE_NS_PREFIX = "http://schemas.microsoft.com/analysisservices/"

_S = f"{{{SOAP_NS}}}"
_X = f"{{{XMLA_NS}}}"


class XmlaRequest:
    """One decoded XMLA call: a Discover or an Execute."""

    def __init__(
        self,
        *,
        verb: str,
        request_type: str | None,
        restrictions: dict[str, list[str]],
        properties: dict[str, str],
        statement: str | None,
        session_id: str | None,
        wants_session: bool,
        ends_session: bool,
    ) -> None:
        self.verb = verb
        self.request_type = request_type
        self.restrictions = restrictions
        self.properties = properties
        self.statement = statement
        self.session_id = session_id
        self.wants_session = wants_session
        self.ends_session = ends_session


def _texts(parent: ElementTree.Element) -> list[str]:
    return [el.text or "" for el in parent]


def parse_request(body: bytes) -> XmlaRequest:
    root = ElementTree.fromstring(body)
    header = root.find(f"{_S}Header")
    session_id = None
    wants_session = False
    ends_session = False
    if header is not None:
        for el in header:
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "Session":
                session_id = el.get("SessionId")
            elif tag == "BeginSession":
                wants_session = True
            elif tag == "EndSession":
                session_id = el.get("SessionId")
                ends_session = True

    body_el = root.find(f"{_S}Body")
    if body_el is None:
        raise ValueError("SOAP body missing")

    discover = body_el.find(f"{_X}Discover")
    if discover is not None:
        request_type = (discover.findtext(f"{_X}RequestType") or "").strip()
        restrictions: dict[str, list[str]] = {}
        rlist = discover.find(f"{_X}Restrictions/{_X}RestrictionList")
        if rlist is not None:
            for el in rlist:
                name = el.tag.rsplit("}", 1)[-1]
                values = _texts(el)
                # A restriction is either <Name>value</Name> or
                # <Name><Value>a</Value><Value>b</Value></Name>.
                restrictions[name] = values if values and len(el) else [el.text or ""]
        properties = _parse_properties(discover.find(f"{_X}Properties"))
        return XmlaRequest(
            verb="Discover",
            request_type=request_type,
            restrictions=restrictions,
            properties=properties,
            statement=None,
            session_id=session_id,
            wants_session=wants_session,
            ends_session=ends_session,
        )

    execute = body_el.find(f"{_X}Execute")
    if execute is not None:
        statement = execute.findtext(f"{_X}Command/{_X}Statement") or ""
        properties = _parse_properties(execute.find(f"{_X}Properties"))
        return XmlaRequest(
            verb="Execute",
            request_type=None,
            restrictions={},
            properties=properties,
            statement=statement,
            session_id=session_id,
            wants_session=wants_session,
            ends_session=ends_session,
        )

    raise ValueError("neither Discover nor Execute in SOAP body")


def _parse_properties(props: ElementTree.Element | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if props is None:
        return out
    plist = props.find(f"{_X}PropertyList")
    if plist is None:
        return out
    for el in plist:
        out[el.tag.rsplit("}", 1)[-1]] = el.text or ""
    return out


def envelope(inner: str, *, session_id: str | None = None) -> bytes:
    """A complete response envelope around already-serialised body XML."""
    header = ""
    if session_id:
        # The XMLA namespace, not the Analysis Services engine one: the
        # client WAITED FOREVER on a Session header in the engine namespace
        # (observed live), because a header it does not recognise is a
        # session that was never granted.
        header = (
            "<soap:Header>"
            f'<Session xmlns="{XMLA_NS}" SessionId="{session_id}"/>'
            "</soap:Header>"
        )
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<soap:Envelope xmlns:soap="{SOAP_NS}">'
        f"{header}<soap:Body>{inner}</soap:Body></soap:Envelope>"
    ).encode("utf-8")


def fault(code: str, message: str) -> bytes:
    """A SOAP fault. Used only where the CLIENT can act on it.

    ErrorCode is NUMERIC on the wire: ADOMD parses it with a number parser
    and dies on a symbolic code (verified live -- FormatException). The
    symbolic code survives in Source; the message carries the real story.
    """
    from xml.sax.saxutils import escape

    return envelope(
        "<soap:Fault>"
        f"<faultcode>soap:Server</faultcode>"
        f"<faultstring>{escape(message)}</faultstring>"
        "<detail>"
        f'<Error ErrorCode="3238658121" Description="{escape(message)}" '
        f'Source="SemanticUI ({escape(code)})" HelpFile=""/>'
        "</detail>"
        "</soap:Fault>"
    )
