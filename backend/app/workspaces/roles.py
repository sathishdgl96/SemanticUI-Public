"""The role ladder, expressed once.

Scattering `role == "admin" or role == "editor"` comparisons across routes is
how authorization drifts apart from itself. Everything that compares two roles
calls `at_least`.
"""

#: Ordered weakest to strongest. The index IS the rank.
ROLES = ("viewer", "editor", "admin")


def rank(role: str) -> int:
    """Position in the ladder, or -1 for anything unrecognised."""
    try:
        return ROLES.index(role)
    except ValueError:
        return -1


def at_least(actual: str, need: str) -> bool:
    """Does `actual` meet or exceed `need`?

    Fails closed on an unknown role. A garbage value in the column ranks -1 and
    therefore satisfies nothing, rather than sorting above every real role the
    way a naive string comparison would ("superuser" > "admin").
    """
    actual_rank, need_rank = rank(actual), rank(need)
    return actual_rank >= 0 and need_rank >= 0 and actual_rank >= need_rank
