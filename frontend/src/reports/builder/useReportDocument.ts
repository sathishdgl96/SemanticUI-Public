import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getReport, updateReport } from "../../api/reports";
import type { ReportDefinition, SemanticViewSummary } from "../../api/types";
import { normalizeDefinition } from "../normalize";

/** The report document itself: fetched, normalised, edited, saved. Owns the
 *  definition state and its persistence; everything ephemeral (selection,
 *  drill, panels) lives in useBuilderInteraction instead. */
export function useReportDocument(reportId: string) {
  const queryClient = useQueryClient();

  const report = useQuery({
    queryKey: ["report", reportId],
    queryFn: () => getReport(reportId),
    enabled: Boolean(reportId),
  });

  const [definition, setDefinition] = useState<ReportDefinition | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (!definition) return Promise.reject(new Error("Report not loaded"));
      return updateReport(reportId, definition);
    },
    onSuccess: (saved) => {
      setSavedJson(JSON.stringify(saved.definition));
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  //: Its own mutation rather than reusing `save`, which takes no argument and
  //: would race the `setDefinition` that precedes it -- the whole point here
  //: is that the view reaches the server, not that it reaches React state.
  const bind = useMutation({
    mutationFn: (next: ReportDefinition) => updateReport(reportId, next),
    onSuccess: (saved) => {
      setDefinition(saved.definition);
      setSavedJson(JSON.stringify(saved.definition));
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  // The route element isn't keyed in App.tsx, so navigating from one report
  // to another (e.g. the Import flow, which navigates to the freshly-imported
  // report's id) reuses the same component instance rather than remounting
  // it. Without this reset, the populate effect below (guarded by
  // `definition === null`) would never fire again once `definition` already
  // holds the PREVIOUS report's data — leaving the old definition on screen,
  // editable, with Save posting it to the new id. `save` is a `useMutation`
  // object that keeps its `isError`/`error` until the next `.mutate()` or an
  // explicit `.reset()` — without resetting it here, failing a Save on
  // report A and then navigating to report B would show report A's failure
  // alert attributed to a report the user never touched.
  useEffect(() => {
    setDefinition(null);
    setSavedJson(null);
    save.reset();
    // `save` deliberately left out of the dependency array: react-query
    // hands back a new mutation result object on every render (its
    // `isPending`/`isError`/etc. all live on that object), so listing it
    // here would re-run this effect — and re-clear `definition` — on every
    // render, not just when `reportId` actually changes. This effect only
    // needs to run on a report-identity change; the `.reset` call above
    // always sees the current render's mutation object regardless of
    // whether that object is declared as a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  useEffect(() => {
    if (report.data && definition === null) {
      // Normalised on the way in, so a document from an older server (or an
      // older cached response) cannot reach the render tree without `pages`
      // and blank the whole builder.
      const normalized = normalizeDefinition(report.data.definition);
      setDefinition(normalized);
      // The baseline is the NORMALISED document, not the raw one: comparing
      // against the raw shape would mark an untouched report dirty the
      // moment it loaded.
      setSavedJson(JSON.stringify(normalized));
    }
  }, [report.data, definition]);

  const dirty = definition !== null && JSON.stringify(definition) !== savedJson;

  /** Binding a view SAVES. It is not an edit to sit on.
   *
   *  It used to change local state only, and everything server-side reads the
   *  report's stored view: Chat, Excel and Connect all answered "this report
   *  is not bound to a semantic view yet" for a report that plainly showed one
   *  on screen. The only way through was to press Save first, which nothing
   *  said. Picking the view is the act that makes a report a report, so it is
   *  written down at the moment it happens.
   */
  const bindView = (picked: SemanticViewSummary) => {
    if (!definition) return;
    bind.mutate({
      ...definition,
      view: { database: picked.database, schema: picked.schema, name: picked.name },
    });
  };

  return { report, definition, setDefinition, dirty, save, bind, bindView };
}
