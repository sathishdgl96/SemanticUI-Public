import type { ExploreDetail, ExploreSummary } from "../api/types";
import { getExplore } from "../api/explores";

interface Props {
  explores: ExploreSummary[];
  openId: string | null;
  onOpen: (explore: ExploreDetail) => void;
  onError: (message: string) => void;
}

/** The saved explores list. Summaries come from the list endpoint; the
 *  document itself is fetched only when one is opened, so a long list costs
 *  one request rather than one per row. */
export default function SavedExplores({ explores, openId, onOpen, onError }: Props) {
  if (explores.length === 0) {
    return (
      <p className="tile-hint">
        No saved explores yet. Build a query and save it to come back to it.
      </p>
    );
  }

  return (
    <ul className="saved-explores">
      {explores.map((explore) => (
        <li key={explore.id}>
          <button
            type="button"
            className={explore.id === openId ? "saved-explore open" : "saved-explore"}
            aria-current={explore.id === openId ? "true" : undefined}
            onClick={() =>
              getExplore(explore.id)
                .then(onOpen)
                .catch(() => onError(`Could not open "${explore.name}".`))
            }
          >
            <span className="saved-explore-name">{explore.name}</span>
            <small>{explore.view.name}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}
