"""The MDX engine, answering for a composite model.

`_Engine` does everything about MDX — axes, drills, tuples, cells,
subtotals — in terms of field references and a `(sql, params, limit)`
triple. None of that changes when a cube is a model rather than a view,
so this replaces exactly one method: how those fields become SQL.

The translation is small and entirely in `composite_source`:

    sales.ORDERS.REVENUE  ->  sales:ORDERS.REVENUE   (a member's own field)
    Customer 360.Customer ->  Customer               (shared, or derived)

and then the model's own planner routes the question to whichever member
views can answer it and stitches them on the conformed dimensions — the
same one statement the API path builds.
"""

from app.composites.compile import compile_composite
from app.composites.planner import plan as plan_composite
from app.config import get_settings
from app.xmla.composite_source import to_model_ref, to_model_refs
from app.xmla.engine import _Engine


class _CompositeEngine(_Engine):
    def __init__(self, session, view, detail, q, definition):
        super().__init__(session, view, detail, q)
        self.definition = definition

    def _compile(self, dims, metrics, filters, *, include_combos=None):
        model_dims = to_model_refs(self.definition, dims)
        model_metrics = to_model_refs(self.definition, metrics)

        # A filter names a field in the cube's namespace; the planner takes
        # it in the model's, so each one is rewritten in place rather than
        # re-derived — the operator, the values and the id all stay whatever
        # the MDX said.
        model_filters = [
            item.model_copy(
                update={"field": to_model_ref(self.definition, item.field)}
            )
            for item in filters
        ]

        stitch = plan_composite(
            self.definition,
            dimensions=model_dims,
            metrics=model_metrics,
            filters=model_filters,
            order_by=[],
            limit=None,
        )
        describes = {
            branch.alias: self.session.describe(
                branch.database, branch.schema, branch.view
            )
            for branch in stitch.branches
        }
        return compile_composite(
            stitch, describes, max_rows=get_settings().export_row_cap
        )


def build_engine(session, view, detail, q, definition):
    """A model's engine, or `None` if this cube is an ordinary view."""
    if definition is None:
        return None
    return _CompositeEngine(session, view, detail, q, definition)


__all__ = ["_CompositeEngine", "build_engine"]
