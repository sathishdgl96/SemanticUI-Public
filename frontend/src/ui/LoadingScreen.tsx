interface LoadingScreenProps {
  /** The deployment's own name. Defaults to ours: the pre-hydration splash
   *  in index.html cannot read /api/branding either, so the whole loading
   *  experience is deliberately the neutral mark until the shell renders. */
  name?: string;
  label?: string;
  /** Fill the viewport rather than the box it is dropped into. True when
   *  this IS the screen (the session check, the login page); false as a
   *  Suspense fallback inside AppShell, where the chrome is already drawn
   *  and only the content area is waiting. */
  page?: boolean;
}

/** The branded wait. Visually the same beat as the splash inlined in
 *  index.html, so the handoff from first paint to React is a continuation
 *  rather than a swap. */
export default function LoadingScreen({
  name = "SemanticUI",
  label = "Loading…",
  page = false,
}: LoadingScreenProps) {
  return (
    <div
      className={page ? "loading-screen loading-screen--page" : "loading-screen"}
      role="status"
      aria-live="polite"
    >
      <span className="loading-brand">
        <span className="loading-mark" aria-hidden="true" />
        <span className="loading-wordmark">{name}</span>
      </span>
      {/* Indeterminate on purpose: we cannot know how far along a bundle
          download or a session check is, and a fake percentage that stalls
          reads worse than honest motion. */}
      <span className="loading-track" aria-hidden="true">
        <span className="loading-fill" />
      </span>
      <span className="loading-label">{label}</span>
      {/* Revealed by CSS after ten seconds -- see index.css. A slow chunk
          deserves the same reassurance the boot splash gives. */}
      <span className="loading-slow">
        Still working — this can take a moment on a slow connection.
      </span>
    </div>
  );
}
