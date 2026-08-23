import { useState } from "react";
import type {
  CompositeDefinition,
  CompositeExpr,
  DerivedMetric,
} from "../api/composites";
import Icon from "../ui/Icon";

const OPS: { value: "+" | "-" | "*" | "/"; label: string }[] = [
  { value: "/", label: "divided by" },
  { value: "*", label: "times" },
  { value: "+", label: "plus" },
  { value: "-", label: "minus" },
];

/** A two-operand expression read back in words. Anything the editor did
 *  not build -- a deeper tree from an imported document -- is described
 *  rather than mangled into a form that cannot hold it. */
function describe(expr: CompositeExpr): string {
  if ("metric" in expr) return expr.metric;
  if ("value" in expr) return String(expr.value);
  const word = OPS.find((op) => op.value === expr.op)?.label ?? expr.op;
  return `${describe(expr.left)} ${word} ${describe(expr.right)}`;
}

/** True when the editor's two-operand form can represent this expression
 *  exactly. Deeper trees stay readable and deletable, but are not offered
 *  for editing in a shape that would silently flatten them. */
function isSimple(expr: CompositeExpr): boolean {
  return (
    !("metric" in expr) &&
    !("value" in expr) &&
    "metric" in expr.left &&
    "metric" in expr.right
  );
}

/**
 * Arithmetic over member metrics, evaluated after each view has
 * aggregated.
 *
 * Two operands and an operator, not a formula box. Revenue per ticket is
 * revenue summed by the sales view, divided by tickets counted by the
 * support view -- and a text field inviting `SUM(x)/SUM(y)` would suggest
 * the numbers can be recomputed here, which is exactly the mistake that
 * produces a ratio of the wrong two things.
 */
export default function DerivedMetrics({
  definition,
  readOnly,
  onChange,
}: {
  definition: CompositeDefinition;
  readOnly: boolean;
  onChange: (metrics: DerivedMetric[]) => void;
}) {
  const [name, setName] = useState("");
  const [left, setLeft] = useState("");
  const [op, setOp] = useState<"+" | "-" | "*" | "/">("/");
  const [right, setRight] = useState("");

  // Every member metric the model could refer to. Typed by the author as
  // `alias:TABLE.METRIC`, because this page has no describe of its own --
  // and a wrong reference is refused by name when the model is saved.
  const aliases = definition.members.map((member) => member.alias);

  const canAdd = Boolean(name.trim() && left.trim() && right.trim());

  function add() {
    const metric: DerivedMetric = {
      name: name.trim(),
      expr: { op, left: { metric: left.trim() }, right: { metric: right.trim() } },
      nullIfDenominatorZero: true,
    };
    onChange([...definition.derivedMetrics, metric]);
    setName("");
    setLeft("");
    setRight("");
  }

  return (
    <section className="model-section">
      <h3>Metrics that combine views</h3>
      <p className="tile-hint">
        Worked out after each view has summed its own numbers — the only
        honest place for a ratio across two views. Dividing row by row
        would be a different number, and a wrong one.
      </p>

      {definition.derivedMetrics.length > 0 && (
        <table className="content-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Worked out as</th>
              <th>If the divisor is zero</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {definition.derivedMetrics.map((metric, index) => (
              <tr key={index}>
                <td>{metric.name}</td>
                <td className="model-expr">{describe(metric.expr)}</td>
                <td>
                  {isSimple(metric.expr) &&
                  (metric.expr as { op: string }).op === "/" ? (
                    <label className="model-chip">
                      <input
                        type="checkbox"
                        checked={metric.nullIfDenominatorZero !== false}
                        disabled={readOnly}
                        onChange={(event) =>
                          onChange(
                            definition.derivedMetrics.map((m, i) =>
                              i === index
                                ? {
                                    ...m,
                                    nullIfDenominatorZero: event.target.checked,
                                  }
                                : m,
                            ),
                          )
                        }
                      />
                      Leave it blank
                    </label>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`Remove ${metric.name}`}
                    disabled={readOnly}
                    onClick={() =>
                      onChange(
                        definition.derivedMetrics.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {aliases.length < 2 ? (
        <p className="tile-hint">
          Add a second view first — a metric that combines views needs two
          to combine.
        </p>
      ) : (
        <div className="model-derived-form">
          <span className="field">
            <label htmlFor="derived-name">Call it</label>
            <input
              id="derived-name"
              placeholder="Revenue per ticket"
              value={name}
              disabled={readOnly}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </span>
          <span className="field">
            <label htmlFor="derived-left">Take</label>
            <input
              id="derived-left"
              placeholder={`${aliases[0]}:ORDERS.REVENUE`}
              value={left}
              disabled={readOnly}
              onChange={(event) => setLeft(event.target.value)}
            />
          </span>
          <span className="field">
            <label htmlFor="derived-op">And</label>
            <select
              id="derived-op"
              value={op}
              disabled={readOnly}
              onChange={(event) =>
                setOp(event.target.value as "+" | "-" | "*" | "/")
              }
            >
              {OPS.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </span>
          <span className="field">
            <label htmlFor="derived-right">This</label>
            <input
              id="derived-right"
              placeholder={`${aliases[1]}:TICKETS.TICKET_COUNT`}
              value={right}
              disabled={readOnly}
              onChange={(event) => setRight(event.target.value)}
            />
          </span>
          <button
            type="button"
            disabled={readOnly || !canAdd}
            onClick={add}
            title={canAdd ? undefined : "Name it, and name both metrics."}
          >
            Add
          </button>
        </div>
      )}
      <p className="tile-hint">
        Write a metric as <code>view:TABLE.METRIC</code> — the alias tells
        the model which view owns it, so two views with a metric of the
        same name are never confused.
      </p>
    </section>
  );
}
