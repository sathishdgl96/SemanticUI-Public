import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { getHome, pinVisual, unpinWidget } from "../../api/home";

/**
 * Put the selected visual on the home page, or take it off again.
 *
 * The button knows which it is doing because it reads the home payload --
 * the same query the home page uses, so the two are never out of step and
 * a pin made here shows up there without a refresh.
 *
 * Disabled on an unsaved report: a widget names a report id, a page id and
 * a visual id, and none of the three is real until the report is saved.
 */
export default function PinToHome({
  reportId,
  pageId,
  visualId,
  saved,
}: {
  reportId: string | undefined;
  pageId: string;
  visualId: string;
  /** False while the report has unsaved changes to the page or visual
   *  being pinned -- the server resolves the SAVED document. */
  saved: boolean;
}) {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: getHome });

  const pinned = home.data?.widgets.find(
    (widget) =>
      widget.reportId === reportId &&
      widget.pageId === pageId &&
      widget.visualId === visualId,
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["home"] });

  const pin = useMutation({
    mutationFn: () => pinVisual({ reportId: reportId as string, pageId, visualId }),
    onSuccess: refresh,
  });

  const unpin = useMutation({
    mutationFn: () => unpinWidget(pinned?.id as string),
    onSuccess: refresh,
  });

  const busy = pin.isPending || unpin.isPending;
  const error = pin.error ?? unpin.error;

  return (
    <section className="format-section">
      <h4>Home</h4>
      <button
        type="button"
        className={pinned ? "secondary" : ""}
        aria-pressed={Boolean(pinned)}
        disabled={!reportId || !saved || busy}
        title={
          !reportId || !saved
            ? "Save the report first — a pinned widget reads the saved report."
            : pinned
              ? "Take this visual off your home page"
              : "Show this visual on your home page"
        }
        onClick={() => (pinned ? unpin.mutate() : pin.mutate())}
      >
        {busy ? "Working…" : pinned ? "Unpin from home" : "Pin to home"}
      </button>
      {error && (
        <p role="alert">
          {error instanceof ApiError ? error.message : "Could not update your home page."}
        </p>
      )}
      <p className="tile-hint">
        A pinned visual stays live: it follows edits to this report, and it
        carries the report and page filters with it.
      </p>
    </section>
  );
}
