import { apiFetch } from "./client";

export type ItemType = "report" | "explore" | "dashboard" | "composite";
export type LibrarySort = "recent" | "name" | "updated";

export interface LibraryParams {
  q?: string;
  favorite?: boolean;
  role?: string;
  sort?: LibrarySort;
}

/** Only non-default values travel, so a list at rest requests the same URL it
 *  always did and its query cache key stays stable across re-renders. */
export function libraryQueryString(params: LibraryParams): string {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.favorite) search.set("favorite", "true");
  if (params.role) search.set("role", params.role);
  if (params.sort && params.sort !== "recent") search.set("sort", params.sort);
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function setFavorite(
  itemType: ItemType,
  id: string,
  favorite: boolean,
): Promise<{ favorite: boolean }> {
  return apiFetch<{ favorite: boolean }>(
    `/api/library/${itemType}/${encodeURIComponent(id)}/favorite`,
    { method: "POST", body: JSON.stringify({ favorite }) },
  );
}

export function recordView(itemType: ItemType, id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/library/${itemType}/${encodeURIComponent(id)}/view`,
    { method: "POST" },
  );
}
