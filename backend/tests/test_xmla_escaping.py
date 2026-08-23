r"""Every XMLA response has to be XML, whatever the data says.

Excel reports a malformed response as "XML parsing failed ... whitespace
expected", which names neither the value nor the field that broke it. The
cause is always the same: `xml.sax.saxutils.escape` handles `&`, `<` and
`>` and leaves quotes alone -- right for element text, wrong inside an
attribute, where a bare `"` ends the value and the parser trips on the
next character.

So these tests do not check for entities. They parse.
"""

from xml.etree import ElementTree

import pytest

from app.xmla.rowset import Column, rows_to_xml
from app.xmla.soap import attr, envelope, fault

#: One value carrying every character that has ever broken one of these.
#: The apostrophe is there because `!r` renders a value containing one
#: with DOUBLE quotes, which is how our own error messages acquired them.
HOSTILE = "Bob's \"Brand\" & <Co> ]]"


def parses(xml: str | bytes) -> ElementTree.Element:
    return ElementTree.fromstring(xml)


class TestAttr:
    def test_escapes_what_an_attribute_needs(self):
        assert '"' not in attr(HOSTILE)
        assert "&quot;" in attr(HOSTILE)
        assert "&amp;" in attr(HOSTILE)
        assert "&lt;" in attr(HOSTILE)

    def test_an_attribute_built_with_it_parses(self):
        assert parses(f'<x a="{attr(HOSTILE)}"/>') is not None

    @pytest.mark.parametrize("value", ['"', "'", "&", "<", ">", "&amp;", HOSTILE])
    def test_round_trips_the_original_text(self, value):
        element = parses(f'<x a="{attr(value)}"/>')
        assert element.get("a") == value


class TestFault:
    def test_a_message_with_a_quote_still_parses(self):
        # The path the user hit: a filter fails, we answer with a fault,
        # and the fault itself was unparseable -- so Excel reported an XML
        # error instead of the reason.
        body = fault("QUERY_ERROR", f'{HOSTILE} is not a shared dimension')
        root = parses(body)
        assert root is not None

    def test_the_message_survives_intact(self):
        body = fault("QUERY_ERROR", HOSTILE)
        root = parses(body)
        error = root.find(".//Error")
        assert error is not None
        assert error.get("Description") == HOSTILE


class TestRowset:
    def test_a_hostile_value_parses_and_round_trips(self):
        xml = rows_to_xml([Column("CUBE_NAME", required=True)], [{"CUBE_NAME": HOSTILE}])
        root = parses(envelope(xml))
        cell = root.find(".//{urn:schemas-microsoft-com:xml-analysis:rowset}CUBE_NAME")
        assert cell is not None
        assert cell.text == HOSTILE

    def test_a_model_named_with_a_quote_lists_as_a_cube(self):
        # A composite's cube name is its workspace and model name, both
        # free text somebody typed.
        name = 'Models.Team."Q3" Revenue'
        xml = rows_to_xml([Column("CUBE_NAME", required=True)], [{"CUBE_NAME": name}])
        root = parses(envelope(xml))
        cell = root.find(".//{urn:schemas-microsoft-com:xml-analysis:rowset}CUBE_NAME")
        assert cell.text == name


class TestDataset:
    def test_a_hierarchy_named_with_a_quote_parses(self):
        from app.xmla.dataset import axis_info_xml

        xml = axis_info_xml("Axis0", [('[CUSTOMER].["ODD"]', [])])
        assert parses(f"<root>{xml}</root>") is not None

    def test_a_member_caption_with_a_quote_parses(self):
        from app.xmla.dataset import member_xml

        xml = member_xml(
            {
                "hierarchy": '[T].["H"]',
                "uname": f"[T].[F].&[{HOSTILE}]",
                "caption": HOSTILE,
                "lname": "[T].[F]",
                "lnum": 0,
            }
        )
        assert parses(f"<root>{xml}</root>") is not None
