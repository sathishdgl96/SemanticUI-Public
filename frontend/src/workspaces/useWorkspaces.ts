import { useQuery } from "@tanstack/react-query";
import { listWorkspaces } from "../api/workspaces";

/** Every workspace the caller belongs to, with their role in each.
 *
 *  Shared by the switcher, the create-report form and the move control, so it
 *  is one query rather than three -- and one cache entry to invalidate when
 *  membership changes. */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: listWorkspaces,
  });
}
