import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch } from "../../api/client";
import type { Hierarchy, SemanticViewDetail, ViewRef } from "../../api/types";
import { describeUrl, isMissingView } from "./viewBinding";

/** The bound view's field lists, described live from Snowflake and cached by
 *  react-query. Also answers whether the report needs (re)binding: no view
 *  yet, or the stored one no longer resolves. */
export function useViewFields(
  reportId: string,
  view: ViewRef,
  reportHierarchies: Hierarchy[] | undefined,
) {
  const queryClient = useQueryClient();

  const viewDetail = useQuery({
    queryKey: ["report-view-detail", view.database, view.schema, view.name],
    queryFn: () => apiFetch<SemanticViewDetail>(describeUrl(view)),
    enabled: Boolean(view.name),
  });

  const refreshFields = useMutation({
    mutationFn: () => apiFetch<SemanticViewDetail>(describeUrl(view, true)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-view-detail"] });
      queryClient.invalidateQueries({ queryKey: ["visual-query"] });
    },
  });

  // A refresh failure belongs to the report it happened on; navigating to
  // another report must not carry the alert along. Same mutation-object
  // reasoning as useReportDocument's reset.
  useEffect(() => {
    refreshFields.reset();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  const dimensions = viewDetail.data?.dimensions ?? [];
  const viewMetrics = viewDetail.data?.metrics ?? [];
  // Raw FACT columns are measure-like too: a PowerBI author expects to drop
  // any numeric field into Values and pick Sum or Average. They are offered
  // alongside the view's own metrics and carry an aggregation choice.
  const facts = viewDetail.data?.facts ?? [];
  const metrics = [...viewMetrics, ...facts];
  const factRefs = facts.map((f) => `${f.table}.${f.name}`);
  // Model-declared hierarchies (none on today's accounts -- see
  // detect_hierarchies) plus the report's own. Ids are namespaced, so the two
  // sources can never collide.
  const hierarchies: Hierarchy[] = [
    ...(viewDetail.data?.modelHierarchies ?? []),
    ...(reportHierarchies ?? []),
  ];

  const needsBind = !view.name || (viewDetail.isError && isMissingView(viewDetail.error));

  return { viewDetail, refreshFields, dimensions, metrics, factRefs, hierarchies, needsBind };
}
