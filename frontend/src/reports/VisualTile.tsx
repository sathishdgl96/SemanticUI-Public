import { useMemo } from "react";
import { ApiError } from "../api/client";
import type {
  Filter,
  Hierarchy,
  QueryResponse,
  ViewRef,
  Visual,
} from "../api/types";
import ResultsTable from "../query/ResultsTable";
import { buildVisualOption, visualTitle } from "../query/renderers";
import AutoChartAdapter from "./AutoChartAdapter";
import MatrixTable from "./MatrixTable";
import MultiRowCard from "./MultiRowCard";
import SlicerControl from "./SlicerControl";
import { slicerFiltersFrom } from "./filters";
import {
  canDrillDown,
  currentLevel,
  hierarchyById,
  hierarchyIdOf,
  type CrossFilter,
  type DrillState,
} from "./filters";
import { useVisualQuery } from "./useVisualQuery";

interface Props {
  visual: Visual;
  view: ViewRef;
  selected: boolean;
  onSelect: (id: string) => void;
  reportFilters?: Filter[];
  pageFilters?: Filter[];
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  onDrill?: (next: DrillState | undefined) => void;
  crossFilter?: CrossFilter | null;
  onCrossFilter?: (next: CrossFilter | null) => void;
  /** Ticked slicer values, keyed by field ref. Ephemeral, like drill. */
  slicerSelections?: Record<string, string[]>;
  onSlicerChange?: (field: string, values: string[]) => void;
  /** Refs the view exposes as raw FACTS, so a measure well can tell an
   *  ad-hoc aggregation from a governed metric. */
  factRefs?: string[];
}

function kpiText(result: QueryResponse, format: unknown): string {
  const value = Number(result.rows[0]?.[0] ?? 0);
  if (!Number.isFinite(value)) return "—";
  // Locale pinned to "en-US" rather than left as the runtime default: the
  // brief's original `new Intl.NumberFormat(undefined, ...)` inherits the
  // OS/ICU locale, which on this machine resolves to "en-IN" and groups
  // digits as "12,34,567" instead of "1,234,567" — making the formatted
  // value (and the test asserting it) nondeterministic across environments.
  return format === "compact"
    ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)
    : new Intl.NumberFormat("en-US").format(value);
}

export default function VisualTile({
  visual,
  view,
  selected,
  onSelect,
  reportFilters = [],
  pageFilters = [],
  hierarchies = [],
  drill,
  onDrill,
  crossFilter = null,
  onCrossFilter,
  slicerSelections = {},
  onSlicerChange,
  factRefs = [],
}: Props) {
  const isSlicer = visual.type === "slicer";
  const ownField = isSlicer ? ((visual.wells.field ?? [])[0] ?? "") : "";

  // A slicer never filters itself, or ticking one value would hide the rest.
  const slicerFilters = slicerFiltersFrom(slicerSelections, ownField);

  const { problems, ready, wells, query } = useVisualQuery(view, visual, {
    reportFilters,
    pageFilters,
    slicerFilters,
    hierarchies,
    drill,
    crossFilter,
    factRefs,
    // A slicer draws its own distinct values from the field-values endpoint;
    // it has no measure, so running the semantic query would be a round trip
    // whose result nothing reads.
    enabled: !isSlicer,
  });

  // The heading names the level currently on screen, not "hierarchy:h1".
  const title = visualTitle({ ...visual, wells });

  const axisRef = (visual.wells.axis ?? [])[0] ?? "";
  const hierarchyId = hierarchyIdOf(axisRef);
  const hierarchy = hierarchyId ? hierarchyById(hierarchies, hierarchyId) : undefined;
  const depth = drill?.hierarchyId === hierarchyId ? drill.path.length : 0;
  const drillable = Boolean(hierarchy && onDrill && canDrillDown(hierarchy, depth));

  const option = useMemo(
    () => (query.data ? buildVisualOption({ ...visual, wells }, query.data) : null),
    // `wells` is rebuilt each render but is value-stable for a given drill
    // position; keying on the resolved axis ref is what actually matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [visual, query.data, (wells.axis ?? [])[0]],
  );

  const drillUp = () => {
    if (!drill) return;
    const path = drill.path.slice(0, -1);
    // An empty path clears the state rather than being kept as an empty one,
    // so "am I drilled?" stays a single null check everywhere.
    onDrill?.(path.length ? { ...drill, path } : undefined);
  };

  const onMark = (category: string) => {
    if (drillable && hierarchy) {
      onDrill?.({
        hierarchyId: hierarchy.id,
        path: [
          ...(drill?.hierarchyId === hierarchy.id ? drill.path : []),
          { field: currentLevel(hierarchy, depth), value: category },
        ],
      });
      return;
    }
    // Not drillable: the click is a cross-filter selection instead. Clicking
    // the same mark again clears it, so a selection is always reversible
    // without hunting for the Clear control.
    const field = (wells.axis ?? [])[0] ?? (wells.legend ?? [])[0];
    if (!field || !onCrossFilter) return;
    const same =
      crossFilter?.sourceVisualId === visual.id &&
      crossFilter.field === field &&
      crossFilter.value === category;
    onCrossFilter(same ? null : { sourceVisualId: visual.id, field, value: category });
  };

  const interactive = drillable || Boolean(onCrossFilter);
  // Absent means shown: a report saved before the Format pane existed must
  // keep the heading it has always had.
  const showTitle = visual.options.showTitle !== false;

  let body: React.ReactNode;
  if (isSlicer) {
    body = (
      <SlicerControl
        visual={visual}
        view={view}
        selected={slicerSelections[ownField] ?? []}
        onChange={(field, values) => onSlicerChange?.(field, values)}
      />
    );
  } else if (hierarchyId && !hierarchy) {
    // Reported on the tile rather than blanking the canvas: the report is
    // still openable and the Axis well is still editable.
    body = (
      <p role="alert" className="tile-error">
        The hierarchy this visual uses is no longer defined on this report. Edit its
        Axis well to pick a field or another hierarchy.
      </p>
    );
  } else if (!ready) {
    body = <p className="tile-hint">This visual needs fields — {problems[0]}</p>;
  } else if (query.isLoading) {
    body = <p className="tile-hint">Loading…</p>;
  } else if (query.isError) {
    body = (
      <p role="alert" className="tile-error">
        {query.error instanceof ApiError ? query.error.message : "Query failed"}
      </p>
    );
  } else if (query.data) {
    if (visual.type === "kpi") {
      body = (
        <p className="kpi-value" data-testid="kpi-value">
          {kpiText(query.data, visual.options.format)}
        </p>
      );
    } else if (visual.type === "table") {
      body = <ResultsTable result={query.data} />;
    } else if (visual.type === "matrix") {
      body = <MatrixTable visual={visual} result={query.data} />;
    } else if (visual.type === "multiCard") {
      body = <MultiRowCard visual={visual} result={query.data} />;
    } else if (option) {
      body = (
        <AutoChartAdapter
          kind="bar"
          title={title}
          option={option}
          categories={query.data.rows.map((r) => String(r[0]))}
          onMarkClick={interactive ? onMark : undefined}
        />
      );
    } else {
      body = <p className="tile-hint">Nothing to chart for this field combination.</p>;
    }
  }

  return (
    <section
      className={selected ? "tile selected" : "tile"}
      // Only a hex value reaches the style attribute; anything else in the
      // saved document is ignored rather than trusted.
      style={
        typeof visual.options.background === "string" &&
        /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(visual.options.background)
          ? { background: visual.options.background }
          : undefined
      }
      aria-label={title || "Untitled visual"}
      // Focusable so Backspace can reach it. The chart itself is focusable
      // only while it is interactive, and drilling *up* has to work from the
      // last level, where it is not.
      tabIndex={onDrill ? 0 : undefined}
      onMouseDown={() => onSelect(visual.id)}
      onKeyDown={(e) => {
        if (e.key === "Backspace" && drill) {
          e.preventDefault();
          drillUp();
        }
      }}
    >
      <header className="tile-head">
        {/* Hidden by Format, but the heading element stays in the tree with
            its text: the tile is still addressable by name to a screen
            reader and to a test, which "no title" should not cost. */}
        <h3
          className={showTitle ? undefined : "sr-only"}
          style={
            typeof visual.options.titleFontSize === "number"
              ? { fontSize: `${visual.options.titleFontSize}px` }
              : undefined
          }
        >
          {title || "Untitled visual"}
        </h3>
        {drill && drill.path.length > 0 && (
          <nav className="drill-path" aria-label="Drill path">
            <button type="button" className="link" onClick={drillUp}>
              Drill up
            </button>
            <span>{drill.path.map((s) => s.value).join(" › ")}</span>
          </nav>
        )}
      </header>
      <div className="tile-body">{body}</div>
    </section>
  );
}
