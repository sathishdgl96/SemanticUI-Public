import type { FieldInfo, Visual } from "../api/types";
import ColorField from "./ColorField";
import { SERIES_COLORS } from "../query/palette";
import {
  CATALOG,
  CATEGORY_LABEL_MODES,
  FONT_SIZES,
  LEGEND_POSITIONS,
  wellsToQuery,
  type VisualType,
} from "./catalog";

interface Props {
  visual: Visual;
  onChange: (next: Visual) => void;
  /** Fields the view exposes, for naming the sort field readably. */
  fields: FieldInfo[];
}

/** Read an option that may be absent, with the default this build applies. */
function flag(visual: Visual, key: string, fallback: boolean): boolean {
  const value = visual.options[key];
  return value === undefined ? fallback : value === true;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="format-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** A text-size chooser. A fixed list rather than a number box: every value on
 *  it is legible at tile size, which free entry cannot promise. */
function SizeField({
  id, label, value, fallback, disabled, onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  fallback: number;
  disabled?: boolean;
  onChange: (size: number) => void;
}) {
  return (
    <>
      <label className="format-field" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={typeof value === "number" ? value : fallback}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
    </>
  );
}

/** PowerBI's paint-roller: how a visual looks, separate from what it shows.
 *
 *  Every control writes to `visual.options`, which the catalog validates by
 *  key. Nothing here changes the query -- except Sort and Top N, which are
 *  row shaping rather than decoration and are grouped as such. */
export default function FormatPane({ visual, onChange, fields }: Props) {
  const type = visual.type as VisualType;
  const spec = CATALOG[type];
  const set = (key: string, value: unknown) =>
    onChange({ ...visual, options: { ...visual.options, [key]: value } });

  // Only fields this visual actually selects can be sorted on: the query API
  // refuses to order by a column it is not returning.
  const { dimensions, metrics } = wellsToQuery(type, visual.wells);
  const sortable = [...dimensions, ...metrics];
  const sort = visual.options.sort as
    | { field: string; direction: "asc" | "desc" }
    | undefined;

  const nameOf = (ref: string) => {
    const field = fields.find((f) => `${f.table}.${f.name}` === ref);
    return field ? field.name : ref;
  };

  const isChart = !["table", "matrix", "kpi", "multiCard", "slicer"].includes(type);

  // A legend distinguishes series. A split-by dimension makes one per value,
  // so any legend well means "several"; otherwise it is one per measure.
  // The colours the author has set, and the slots to offer. A measure well
  // gives one series per measure; a legend well gives one per VALUE, which is
  // not knowable without the data -- so eight slots, which is the palette's
  // length and more than any legible chart.
  const colors = Array.isArray(visual.options.colors)
    ? (visual.options.colors as unknown[])
    : [];
  const measures = [
    ...(visual.wells.values ?? []),
    ...(visual.wells.lineValues ?? []),
  ];
  const seriesSlots =
    (visual.wells.legend ?? []).length > 0 || measures.length === 0
      ? Array.from({ length: 8 }, (_, i) => `Series ${i + 1}`)
      : measures.map((ref) => nameOf(ref));

  const setColor = (index: number, hex: string | undefined) => {
    const next = [...colors];
    next[index] = hex;
    // Trailing holes are dropped so the saved document stays the shortest
    // thing that says what was chosen.
    while (next.length && next[next.length - 1] === undefined) next.pop();
    set("colors", next.length ? next.map((c) => c ?? null) : undefined);
  };

  const hasSeriesToDistinguish =
    (visual.wells.legend ?? []).length > 0 ||
    (visual.wells.values ?? []).length + (visual.wells.lineValues ?? []).length > 1;

  return (
    <div className="format-pane">
      <Section title="Title">
        <label className="format-check">
          <input
            type="checkbox"
            checked={flag(visual, "showTitle", true)}
            onChange={(e) => set("showTitle", e.target.checked)}
          />
          Show title
        </label>
        <label className="format-field" htmlFor={`title-${visual.id}`}>
          Title text
        </label>
        <input
          id={`title-${visual.id}`}
          value={visual.title}
          placeholder="Named from the fields"
          onChange={(e) => onChange({ ...visual, title: e.target.value })}
        />
        <SizeField
          id={`title-size-${visual.id}`}
          label="Title text size"
          value={visual.options.titleFontSize}
          fallback={13}
          disabled={!flag(visual, "showTitle", true)}
          onChange={(size) => set("titleFontSize", size)}
        />
      </Section>

      {isChart && (
        <Section title="Legend">
          <label className="format-check">
            <input
              type="checkbox"
              checked={flag(visual, "showLegend", true)}
              onChange={(e) => set("showLegend", e.target.checked)}
            />
            Show legend
          </label>
          <label className="format-field" htmlFor={`legend-${visual.id}`}>
            Position
          </label>
          <select
            id={`legend-${visual.id}`}
            value={(visual.options.legendPosition as string) ?? "bottom"}
            onChange={(e) => set("legendPosition", e.target.value)}
            disabled={!flag(visual, "showLegend", true)}
          >
            {LEGEND_POSITIONS.map((position) => (
              <option key={position} value={position}>
                {position[0].toUpperCase() + position.slice(1)}
              </option>
            ))}
          </select>
          <label className="format-field" htmlFor={`legend-title-${visual.id}`}>
            Legend title
          </label>
          <input
            id={`legend-title-${visual.id}`}
            value={(visual.options.legendTitle as string) ?? ""}
            placeholder="No title"
            disabled={!flag(visual, "showLegend", true)}
            onChange={(e) => set("legendTitle", e.target.value || undefined)}
          />
          <SizeField
            id={`legend-size-${visual.id}`}
            label="Legend text size"
            value={visual.options.legendFontSize}
            fallback={11}
            disabled={!flag(visual, "showLegend", true)}
            onChange={(size) => set("legendFontSize", size)}
          />
          {!hasSeriesToDistinguish && (
            // Said here rather than left to be discovered: with one series the
            // renderer draws no legend however this box is ticked, because a
            // legend of one entry only repeats the title.
            <p className="tile-hint">
              One series, so no legend is drawn. Add a measure, or split by a
              field, to give it something to tell apart.
            </p>
          )}
        </Section>
      )}

      {isChart && (
        <Section title="Values">
          <label className="format-field" htmlFor={`numfmt-${visual.id}`}>
            Number format
          </label>
          {/* Drives the axis labels as well as the data labels: two different
              renderings of the same measure on one chart would be a reason to
              distrust both. */}
          <select
            id={`numfmt-${visual.id}`}
            value={(visual.options.format as string) ?? "full"}
            onChange={(e) => set("format", e.target.value)}
          >
            <option value="full">1,234,567</option>
            <option value="compact">1.2M</option>
          </select>
          <label className="format-check">
            <input
              type="checkbox"
              checked={flag(visual, "showDataLabels", false)}
              onChange={(e) => set("showDataLabels", e.target.checked)}
            />
            Show data labels
          </label>
          <SizeField
            id={`label-size-${visual.id}`}
            label="Label text size"
            value={visual.options.dataLabelFontSize}
            fallback={11}
            disabled={!flag(visual, "showDataLabels", false)}
            onChange={(size) => set("dataLabelFontSize", size)}
          />
        </Section>
      )}

      <Section title="Colours">
        {/* One swatch per series, in the order the chart draws them. A short
            list is fine: anything past the end falls back to the shared
            palette, so setting the first colour does not oblige you to set
            the rest. */}
        {isChart &&
          seriesSlots.map((slot, index) => (
            <ColorField
              key={index}
              label={slot}
              value={(colors[index] as string) ?? ""}
              fallback={SERIES_COLORS[index % SERIES_COLORS.length]}
              onChange={(hex) => setColor(index, hex)}
            />
          ))}
        <ColorField
          label="Tile background"
          value={(visual.options.background as string) ?? ""}
          fallback="#ffffff"
          onChange={(hex) => set("background", hex)}
        />
      </Section>

      {isChart && (
        <Section title="Axes">
          <label className="format-check">
            <input
              type="checkbox"
              checked={flag(visual, "showGridlines", true)}
              onChange={(e) => set("showGridlines", e.target.checked)}
            />
            Show gridlines
          </label>
          <label className="format-field" htmlFor={`xtitle-${visual.id}`}>
            X axis title
          </label>
          <input
            id={`xtitle-${visual.id}`}
            value={(visual.options.xAxisTitle as string) ?? ""}
            placeholder="No title"
            onChange={(e) => set("xAxisTitle", e.target.value || undefined)}
          />
          <label className="format-field" htmlFor={`ytitle-${visual.id}`}>
            Y axis title
          </label>
          <input
            id={`ytitle-${visual.id}`}
            value={(visual.options.yAxisTitle as string) ?? ""}
            placeholder="No title"
            onChange={(e) => set("yAxisTitle", e.target.value || undefined)}
          />
          <SizeField
            id={`axis-size-${visual.id}`}
            label="Axis text size"
            value={visual.options.axisFontSize}
            fallback={11}
            onChange={(size) => set("axisFontSize", size)}
          />
          {/* The chart drops any label that would touch its neighbour, so a
              bar per day names one day in five. Slanting the labels is how
              every one gets drawn. */}
          <label className="format-field" htmlFor={`category-labels-${visual.id}`}>
            Category labels
          </label>
          <select
            id={`category-labels-${visual.id}`}
            value={(visual.options.categoryLabels as string) ?? "auto"}
            onChange={(e) =>
              set("categoryLabels", e.target.value === "auto" ? undefined : e.target.value)
            }
          >
            {CATEGORY_LABEL_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </Section>
      )}

      {/* The type's own options: stacking, donut hole, subtotals, number
          format. Rendered from the catalog rather than hard-coded, so a new
          type's option appears here the moment the catalog declares it. */}
      {spec.options.length > 0 && (
        <Section title="Display">
          {spec.options.map((key) =>
            key === "format" ? (
              <div key={key}>
                <label className="format-field" htmlFor={`format-${visual.id}`}>
                  Number format
                </label>
                <select
                  id={`format-${visual.id}`}
                  value={(visual.options.format as string) ?? "full"}
                  onChange={(e) => set("format", e.target.value)}
                >
                  <option value="full">1,234,567</option>
                  <option value="compact">1.2M</option>
                </select>
              </div>
            ) : (
              <label className="format-check" key={key}>
                <input
                  type="checkbox"
                  checked={visual.options[key] === true}
                  onChange={(e) => {
                    // Stacked and 100% stacked are the same axis in PowerBI's
                    // gallery: turning one on turns the other off, rather than
                    // leaving a contradictory pair in the saved document.
                    if (key === "stacked" && e.target.checked) {
                      onChange({
                        ...visual,
                        options: { ...visual.options, stacked: true, stacked100: false },
                      });
                      return;
                    }
                    if (key === "stacked100" && e.target.checked) {
                      onChange({
                        ...visual,
                        options: { ...visual.options, stacked100: true, stacked: false },
                      });
                      return;
                    }
                    set(key, e.target.checked);
                  }}
                />
                {OPTION_LABEL[key] ?? key}
              </label>
            ),
          )}
        </Section>
      )}

      <Section title="Sort and rows">
        <label className="format-field" htmlFor={`sort-${visual.id}`}>
          Sort by
        </label>
        <select
          id={`sort-${visual.id}`}
          value={sort?.field ?? ""}
          onChange={(e) =>
            set(
              "sort",
              e.target.value
                ? { field: e.target.value, direction: sort?.direction ?? "desc" }
                : undefined,
            )
          }
        >
          <option value="">Default order</option>
          {sortable.map((ref) => (
            <option key={ref} value={ref}>
              {nameOf(ref)}
            </option>
          ))}
        </select>

        <label className="format-field" htmlFor={`direction-${visual.id}`}>
          Direction
        </label>
        <select
          id={`direction-${visual.id}`}
          value={sort?.direction ?? "desc"}
          disabled={!sort?.field}
          onChange={(e) =>
            set("sort", { field: sort?.field ?? "", direction: e.target.value })
          }
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>

        <label className="format-field" htmlFor={`topn-${visual.id}`}>
          Show top
        </label>
        <input
          id={`topn-${visual.id}`}
          type="number"
          min={1}
          placeholder="All rows"
          value={(visual.options.topN as number) ?? ""}
          onChange={(e) =>
            set("topN", e.target.value ? Number(e.target.value) : undefined)
          }
        />
        {!sort?.field && (
          <p className="tile-hint">
            Top N needs a sort: without one, "top" has no meaning.
          </p>
        )}
      </Section>
    </div>
  );
}

const OPTION_LABEL: Record<string, string> = {
  stacked: "Stacked",
  stacked100: "100% stacked",
  donut: "Donut hole",
  subtotals: "Show totals",
  multiSelect: "Allow multiple selections",
};
