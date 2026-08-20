import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSessionContext, setSessionContext } from "../api/session";

/**
 * The role and warehouse this session runs as.
 *
 * Switching either invalidates every query: the same report can
 * legitimately return different rows under a different role, so cached
 * results from the previous one are not merely stale, they are wrong.
 */
export function useSessionContext() {
  const queryClient = useQueryClient();

  const context = useQuery({
    queryKey: ["session-context"],
    queryFn: getSessionContext,
    // Roles and warehouses change in Snowflake, not here; refetching on
    // every window focus would cost two SHOW statements for nothing.
    staleTime: 5 * 60 * 1000,
  });

  const switchTo = useMutation({
    // Wrapped, not passed directly: the mutation function is called with
    // a second argument carrying query-client internals, which has no
    // business reaching an API client.
    mutationFn: (next: { role?: string; warehouse?: string }) =>
      setSessionContext(next),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return {
    context: context.data,
    isLoading: context.isLoading,
    error: context.error,
    switchTo,
  };
}
