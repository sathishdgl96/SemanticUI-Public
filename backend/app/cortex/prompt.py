"""Build the model's prompt from a catalog and a question.

FIELD NAMES AND TYPES ONLY. No rows, ever. If a row reaches this string, the
model has seen data it was never meant to -- and there is a test asserting it
does not.

Nothing here is a security control. The prompt ASKS for good behaviour; the
catalog validation in spec.py is what ENFORCES it.
"""

INSTRUCTIONS = """\
You translate a business question into a query over a Snowflake semantic view.

Answer with a single JSON object and nothing else:

{
  "dimensions": ["TABLE.FIELD", ...],
  "metrics": ["TABLE.FIELD", ...],
  "filters": [{"id": "q1", "field": "TABLE.FIELD", "op": "is", "values": ["X"]}],
  "orderBy": [{"field": "FIELD", "direction": "desc"}],
  "limit": 20,
  "explanation": "one sentence describing what you asked for"
}

Rules:
- Use ONLY the fields listed below. Never invent a field name.
- Metrics must come from the metric list; dimensions from the dimension list.
- Allowed filter operators: is, isNot, between, relativeDate.
  - is / isNot take "values": a list of strings.
  - between takes "from" and "to".
  - relativeDate takes "unit" (day, month, year) and "count", or
    "preset" ("monthToDate" or "yearToDate").
- orderBy may only name a field you selected.
- Do not write SQL. Do not add any key not shown above.
"""


def _field_lines(fields: list[dict]) -> str:
    return "\n".join(
        f"  - {(f.get('table') or '')}.{f['name']} ({f.get('dataType') or 'unknown'})"
        for f in fields
    )


#: How many earlier turns the model is shown. A chat that carries its whole
#: history grows the prompt without bound; the last few turns are what a
#: follow-up ("now split that by region") actually refers to.
MAX_HISTORY_TURNS = 6


def _history_lines(history: list) -> str:
    lines = []
    for turn in history[-MAX_HISTORY_TURNS:]:
        question = (turn.get("question") or "").replace('"""', "'''")
        answer = (turn.get("answer") or "").replace('"""', "'''")
        lines.append(f"  Q: {question}")
        if answer:
            lines.append(f"  A: {answer}")
    return "\n".join(lines)


def build_prompt(
    detail: dict,
    question: str,
    *,
    report_filters: list | None = None,
    history: list | None = None,
) -> str:
    parts = [INSTRUCTIONS, "\nDimensions:", _field_lines(detail.get("dimensions", []))]

    facts = detail.get("facts", [])
    if facts:
        parts += ["\nFacts (filterable, not aggregated):", _field_lines(facts)]

    parts += ["\nMetrics:", _field_lines(detail.get("metrics", []))]

    if report_filters:
        described = ", ".join(f"{f.get('field')} {f.get('op')}" for f in report_filters)
        parts.append(
            "\nThe report is already filtered by: "
            f"{described}. Do not repeat these unless the question changes them."
        )

    if history:
        # Earlier QUESTIONS and the model's own one-sentence explanations --
        # never rows. The no-data-in-the-prompt rule is the reason this feature
        # is safe to point at a governed model, and a conversation is exactly
        # where it would be easiest to lose by accident.
        parts += [
            "\nEarlier in this conversation:",
            _history_lines(history),
            "\nThe new question may refer to the most recent one "
            '("that", "those", "break it down by ..."). Resolve it against the '
            "history above, then answer it in full: your JSON must name every "
            "field the new query needs, not only the ones that changed.",
        ]

    # The question is delimited, and the delimiter is stripped out of it so it
    # cannot close the block. This is legibility, not security -- validation is
    # what protects the system.
    safe_question = (question or "").replace('"""', "'''")
    parts.append(f'\nQuestion:\n"""\n{safe_question}\n"""\n')
    return "\n".join(parts)
