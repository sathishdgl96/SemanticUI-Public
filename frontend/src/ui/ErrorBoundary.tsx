import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** The last line before a white screen. A throw anywhere under here used to
 *  take the whole app down with no way back; now it lands on a page that
 *  says so and offers two exits.
 *
 *  Deliberately router-free -- a plain anchor, not a Link. It can therefore
 *  wrap the router itself, and "Go to Home" is a real navigation that drops
 *  whatever state caused the crash instead of carrying it along. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The browser console is the only reporter we have; keep the component
    // stack with it, since the message alone rarely locates the throw.
    console.error("unhandled render error", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="status-page">
        <h1 className="status-code">500</h1>
        <h2 className="status-headline">Something went wrong.</h2>
        <p className="status-detail">
          The page stopped while it was rendering. Trying again often clears
          it; if it keeps happening, send the details below to your
          administrator.
        </p>
        <p className="status-actions">
          <button type="button" className="button" onClick={this.reset}>
            Try again
          </button>
          <a className="link" href="/">
            Go to Home
          </a>
        </p>
        {/* Collapsed: the message is here for whoever needs it without
            greeting everyone else with a stack trace. */}
        <details className="status-details">
          <summary>Technical details</summary>
          <pre>{error.message}</pre>
        </details>
      </section>
    );
  }
}
