import { useQuery } from "@tanstack/react-query";
import { listExplores } from "../api/explores";
import type { ExploreDetail } from "../api/types";
import { FacetChips } from "../library/FacetChips";
import { SearchBar } from "../library/SearchBar";
import { useLibraryQuery } from "../library/useLibraryQuery";
import SavedExplores from "./SavedExplores";

interface Props {
  openId: string | null;
  onOpen: (explore: ExploreDetail) => void;
  onError: (message: string) => void;
}

/** The saved-explores region: its own query, its own browse controls.
 *
 *  Lifted out of ExplorerPage because the list and the query builder share
 *  nothing but the page they sit on -- and searching a hundred explores is
 *  its own concern, not part of composing one. */
export default function SavedExploresPanel({ openId, onOpen, onError }: Props) {
  const browse = useLibraryQuery();

  const explores = useQuery({
    queryKey: ["explores", browse.params],
    queryFn: () => listExplores(undefined, browse.params),
    // Keeps the list on screen while a search refetches, so typing does not
    // blank the panel between keystrokes.
    placeholderData: (previous) => previous,
  });

  const listed = explores.data?.explores ?? [];
  const filtering = browse.activeFacets.length > 0;

  return (
    <>
      <div className="library-bar library-bar-compact">
        <SearchBar
          value={browse.params.q ?? ""}
          onChange={browse.setSearch}
          placeholder="Search saved explores"
        />
        <button
          type="button"
          className={browse.params.favorite ? "toggle-button on" : "toggle-button"}
          aria-pressed={browse.params.favorite ?? false}
          aria-label="Pinned only"
          title="Pinned only"
          onClick={browse.toggleFavoriteFilter}
        >
          <span aria-hidden="true">★</span>
        </button>
      </div>
      <FacetChips
        facets={browse.activeFacets}
        onClear={browse.clearFacet}
        shown={listed.length}
        total={explores.data ? listed.length : 0}
      />

      {explores.isLoading && <p>Loading explores…</p>}
      {explores.isError && <p role="alert">Could not load saved explores.</p>}
      {/* A filtered-to-nothing list is not the same as having none: one
          wants a first explore, the other wants the filter undone. */}
      {explores.data && listed.length === 0 && filtering && (
        <div className="tile-hint">
          <p>
            No explores match
            {browse.params.q?.trim() ? ` “${browse.params.q.trim()}”` : " those filters"}.
          </p>
          <button type="button" className="secondary" onClick={browse.clearAll}>
            Clear filters
          </button>
        </div>
      )}
      {explores.data && !(listed.length === 0 && filtering) && (
        <SavedExplores
          explores={listed}
          openId={openId}
          onOpen={onOpen}
          onError={onError}
        />
      )}
    </>
  );
}
