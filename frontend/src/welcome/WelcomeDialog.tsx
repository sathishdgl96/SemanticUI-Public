import { Link } from "react-router-dom";
import type { RefObject } from "react";
import type { Welcome } from "../api/home";
import Dialog from "../ui/Dialog";

interface Props {
  name: string;
  welcome: Welcome;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * The paragraph that says what this product is, once.
 *
 * Every empty state in the app teaches the *next click* -- "Pick a field
 * first", "Add a visual from the Visualizations pane" -- and they are good at
 * it. None teaches the arc, so a newcomer learns the shape one dead end at a
 * time. That arc is what this says.
 *
 * It branches on what the person can already see, because advice you cannot
 * act on teaches people to stop reading: a viewer dropped into somebody
 * else's workspace should be shown how to read and export what is already
 * there, not told to build a report they have no rights to build.
 */
export default function WelcomeDialog({
  name,
  welcome,
  onClose,
  returnFocusTo,
}: Props) {
  const teamStart = welcome.path === "team";
  return (
    <Dialog title={`Welcome to ${name}`} onClose={onClose} returnFocusTo={returnFocusTo}>
      <p className="welcome-lead">
        {teamStart
          ? "Your team already has work here. The quickest way in is to open something they have built."
          : "Everything here starts from a semantic model in Snowflake — the tables, the joins and the measures your organisation has already defined."}
      </p>

      <ol className="welcome-arc">
        <li>
          <strong>Explore</strong> a model: pick fields, filter, and see the SQL
          that ran.
        </li>
        <li>
          <strong>Save</strong> what you find, and turn it into a{" "}
          <strong>report</strong> — a canvas of visuals with pages and filters.
        </li>
        <li>
          <strong>Pin</strong> a report's visuals onto a{" "}
          <strong>dashboard</strong> to gather several reports in one place.
        </li>
        <li>
          Take any of it to <strong>Excel</strong> — the numbers, and a live
          connection that refreshes them.
        </li>
      </ol>

      <p className="welcome-note">
        Every query runs as you, on your own Snowflake credentials. Sharing a
        report shares its definition, never its numbers.
      </p>

      {teamStart && welcome.canAuthor ? (
        <p className="welcome-note">
          When you want to build your own, start from Explore and save it into a
          workspace you can write to.
        </p>
      ) : null}

      <div className="welcome-actions">
        {teamStart ? (
          <Link className="button" to="/reports" onClick={onClose}>
            Open what your team has built
          </Link>
        ) : (
          <Link className="button" to="/explore" onClick={onClose}>
            Explore a model
          </Link>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Get started
        </button>
      </div>
    </Dialog>
  );
}
