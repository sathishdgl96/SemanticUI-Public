import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { CompositeMember } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";

/**
 * Each member view's describe, keyed by alias.
 *
 * On the caller's own connection, like every other read: a view they
 * cannot see simply has no describe, and the editor then offers no
 * columns for it rather than pretending to know them.
 *
 * One query per member rather than one for the model, because the
 * describe cache is per view — a model sharing a view with a report the
 * user already opened costs nothing to add.
 */
export function useMemberDescribes(members: CompositeMember[]) {
  const results = useQueries({
    queries: members.map((member) => ({
      queryKey: ["semantic-view", member.database, member.schema, member.view],
      queryFn: () =>
        apiFetch<SemanticViewDetail>(
          `/api/semantic-views/${encodeURIComponent(member.database)}/` +
            `${encodeURIComponent(member.schema)}/${encodeURIComponent(member.view)}`,
        ),
      // A model is edited over minutes and a describe does not change
      // underneath it; refetching on every focus would re-hit Snowflake
      // for a field list nobody asked to refresh.
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  });

  // Rebuilt each render rather than memoised. `useQueries` hands back a
  // fresh array every time, so a memo would need a hand-rolled key to be
  // worth anything -- and this is a handful of entries over at most eight
  // views, which is not work worth outsmarting the linter for.
  const byAlias: Record<string, SemanticViewDetail | undefined> = {};
  members.forEach((member, index) => {
    byAlias[member.alias.toLowerCase()] = results[index]?.data;
  });

  return {
    byAlias,
    loading: results.some((result) => result.isLoading),
    /** Aliases whose view could not be read, so the editor can say which. */
    unreadable: members
      .filter((_, index) => Boolean(results[index]?.error))
      .map((member) => member.alias),
  };
}
