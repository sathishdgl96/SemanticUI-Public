"""Rules for turning report data into spreadsheet cells safely.

Pure functions, no I/O. The interesting one is `looks_like_formula`: values
come from the user's warehouse, not from us, and the workbook is opened by
someone else.
"""

#: A spreadsheet evaluates a cell whose text begins with one of these. The data
#: is not ours, so any of them could arrive from a warehouse column.
FORMULA_PREFIXES = ("=", "+", "-", "@")

#: Excel's own limit. A longer name makes the workbook unopenable.
MAX_SHEET_NAME = 31

#: Excel refuses these in a sheet name outright.
_FORBIDDEN = frozenset(["[", "]", ":", "*", "?", "/", "\\"])

_FALLBACK_SHEET_NAME = "Sheet"


def looks_like_formula(value: object) -> bool:
    """Would a spreadsheet treat this text as a formula?

    Only strings can be. A negative NUMBER is a number, and writing it as text
    would break every sum in the sheet -- so the type check comes first.

    Leading whitespace is stripped before the check, because Excel tolerates it
    and a naive `startswith` does not.
    """
    if not isinstance(value, str):
        return False
    return value.lstrip().startswith(FORMULA_PREFIXES)


def safe_sheet_name(title: str, taken: set[str]) -> str:
    """An Excel-legal, unique sheet name derived from a visual's title.

    Collisions get a numeric suffix rather than silently overwriting the
    earlier sheet -- two visuals called "Revenue" is completely normal.
    """
    cleaned = "".join(c for c in (title or "") if c not in _FORBIDDEN).strip()
    base = (cleaned or _FALLBACK_SHEET_NAME)[:MAX_SHEET_NAME]

    if base not in taken:
        return base

    counter = 2
    while True:
        suffix = f" ({counter})"
        # Trimmed so the suffix fits: a 31-character title plus " (2)" would
        # otherwise produce a name Excel refuses to open.
        candidate = base[: MAX_SHEET_NAME - len(suffix)] + suffix
        if candidate not in taken:
            return candidate
        counter += 1
