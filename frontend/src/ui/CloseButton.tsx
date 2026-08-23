/** The one way to close a panel.
 *
 *  An icon rather than the word "Close": every panel had its own, they sat
 *  in different places at different sizes, and a word in the corner of a
 *  dialog is read before the thing the dialog is for. The accessible name
 *  stays a word, so nothing is lost to a screen reader.
 */
export default function CloseButton({
  onClick,
  label = "Close",
}: {
  onClick: () => void;
  /** Overridden where several panels can be open at once and "Close" alone
   *  would not say which -- "Close chat", "Close filters". */
  label?: string;
}) {
  return (
    <button type="button" className="panel-close" aria-label={label} title={label} onClick={onClick}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
