import { Link } from "react-router-dom";

/** The catch-all route's page. Without it an unknown path renders nothing
 *  at all: the server already answers deep links with the shell (see
 *  SpaStaticFiles in app/main.py), so React, not nginx, owns this case. */
export default function NotFoundPage() {
  return (
    <section className="status-page">
      <h1 className="status-code">404</h1>
      <h2 className="status-headline">This page doesn't exist.</h2>
      <p className="status-detail">
        The link may be out of date, or the report may have been deleted.
      </p>
      <p className="status-actions">
        <Link className="button" to="/">
          Go to Home
        </Link>
        {/* History, not a route: "back" should return where they came from,
            which is usually not the home page. */}
        <button type="button" className="link" onClick={() => history.back()}>
          Back
        </button>
      </p>
    </section>
  );
}
