from app.export.sheets import (
    FORMULA_PREFIXES,
    MAX_SHEET_NAME,
    looks_like_formula,
    safe_sheet_name,
)


class TestFormulaDetection:
    """A warehouse value beginning = + - or @ is a FORMULA to whoever opens the
    file. The data is not ours, and the reader is not us."""

    def test_every_dangerous_prefix_is_detected(self):
        for prefix in FORMULA_PREFIXES:
            assert looks_like_formula(f"{prefix}cmd|'/c calc'!A0") is True

    def test_the_classic_payloads_are_detected(self):
        for payload in (
            "=cmd|'/c calc'!A0",
            '=HYPERLINK("http://evil","click")',
            "+HYPERLINK(1)",
            "-2+3+cmd|' /C calc'!A0",
            "@SUM(1+1)*cmd|' /C calc'!A0",
        ):
            assert looks_like_formula(payload) is True, payload

    def test_ordinary_text_is_not(self):
        for value in ("EAST", "Q1 2026", "a-b", "sales@example.com", ""):
            assert looks_like_formula(value) is False, value

    def test_leading_whitespace_does_not_hide_a_formula(self):
        """Excel tolerates a leading space; a naive startswith does not."""
        assert looks_like_formula("  =1+1") is True
        assert looks_like_formula("\t=1+1") is True
        assert looks_like_formula("\n@SUM(1)") is True

    def test_numbers_are_not_formulas(self):
        """-5 begins with a dangerous prefix but is a number. Writing it as
        text would break every sum in the sheet."""
        assert looks_like_formula(-5) is False
        assert looks_like_formula(3.14) is False
        assert looks_like_formula(None) is False
        assert looks_like_formula(True) is False


class TestSheetNames:
    def test_a_plain_title_survives(self):
        assert safe_sheet_name("Revenue by region", set()) == "Revenue by region"

    def test_forbidden_characters_are_removed(self):
        """Excel refuses [ ] : * ? / \\ outright -- a workbook containing one
        fails to open at all."""
        assert safe_sheet_name("A/B:C*D?E[F]G\\H", set()) == "ABCDEFGH"

    def test_names_are_capped_at_excels_limit(self):
        assert len(safe_sheet_name("x" * 60, set())) <= MAX_SHEET_NAME

    def test_a_duplicate_is_disambiguated_not_overwritten(self):
        assert safe_sheet_name("Revenue", {"Revenue"}) == "Revenue (2)"

    def test_repeated_duplicates_keep_counting(self):
        assert safe_sheet_name("Revenue", {"Revenue", "Revenue (2)"}) == "Revenue (3)"

    def test_a_long_duplicate_still_fits(self):
        """The suffix must not push the name past the cap."""
        long = "y" * MAX_SHEET_NAME
        name = safe_sheet_name(long, {long})
        assert len(name) <= MAX_SHEET_NAME
        assert name != long

    def test_an_empty_title_gets_a_usable_name(self):
        """An untitled visual is normal; a nameless sheet is not allowed."""
        assert safe_sheet_name("", set())
        assert safe_sheet_name("   ", set())

    def test_a_title_of_only_forbidden_characters_gets_a_usable_name(self):
        assert safe_sheet_name("[]:*?/\\", set())

    def test_the_summary_sheet_name_can_be_reserved(self):
        """The workbook reserves "Summary" before adding data sheets, so a
        visual actually titled "Summary" must not collide with it."""
        assert safe_sheet_name("Summary", {"Summary"}) == "Summary (2)"
