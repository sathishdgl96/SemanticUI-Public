import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import {
  getComposite,
  updateComposite,
  type Binding,
  type CompositeDefinition,
  type CompositeMember,
  type SharedDimension,
} from "../api/composites";
import type { SemanticViewSummary } from "../api/types";
import Icon from "../ui/Icon";
import DerivedMetrics from "./DerivedMetrics";
import ModelPreview from "./ModelPreview";

/** An alias suggested from a view name: SALES_SV -> sales. Only ever a
 *  suggestion -- the field is editable, because what a team calls a view
 *  and what it calls the thing inside a model are different questions. */
function suggestAlias(view: string, taken: string[]): string {
  const base =
    view
      .toLowerCase()
      .replace(/_?(sv|semantic|view)$/g, "")
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "view";
  const start = /^[a-z]/.test(base) ? base : `v${base}`;
  if (!taken.includes(start)) return start;
  for (let n = 2; n < 99; n += 1) {
    if (!taken.includes(`${start}${n}`)) return `${start}${n}`;
  }
  return `${start}_x`;
}

function emptyBinding(): Binding {
  return { table: "", column: "" };
}

/**
 * Authoring a model over several semantic views.
 *
 * The page exists because the mapping cannot be guessed. Two views both
 * knowing a customer is not evidence that their key columns mean the same
 * thing, so somebody who understands both says so here, once, and every
 * question asked of the model afterwards relies on that statement.
 */
export default function ModelPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CompositeDefinition | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const model = useQuery({
    queryKey: ["composite", id],
    queryFn: () => getComposite(id),
    enabled: Boolean(id),
  });

  // The catalogue of views this user can actually see. Snowflake decides
  // what is in it, which is why the picker is a list rather than free text.
  const views = useQuery({
    queryKey: ["semantic-views"],
    queryFn: () =>
      apiFetch<{ views: SemanticViewSummary[] }>("/api/semantic-views"),
  });

  useEffect(() => {
    if (model.data && !draft) setDraft(model.data.definition);
  }, [model.data, draft]);

  const save = useMutation({
    mutationFn: (definition: CompositeDefinition) =>
      updateComposite(id, definition),
    onSuccess: (saved) => {
      setSaveError(null);
      setDraft(saved.definition);
      queryClient.invalidateQueries({ queryKey: ["composite", id] });
      queryClient.invalidateQueries({ queryKey: ["composites"] });
    },
    onError: (failure) =>
      setSaveError(
        failure instanceof ApiError ? failure.message : "Could not save this model.",
      ),
  });

  const aliases = useMemo(
    () => (draft?.members ?? []).map((member) => member.alias),
    [draft],
  );

  if (model.isLoading || !draft) return <p className="empty">Loading…</p>;
  if (model.error) {
    return <p role="alert">This model could not be opened.</p>;
  }

  const readOnly = model.data?.myRole === "viewer";

  function patch(next: Partial<CompositeDefinition>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  function addMember(fullName: string) {
    const [database, schema, view] = fullName.split(".");
    if (!database || !schema || !view) return;
    const member: CompositeMember = {
      alias: suggestAlias(view, aliases),
      database,
      schema,
      view,
    };
    patch({ members: [...draft!.members, member] });
  }

  function removeMember(alias: string) {
    // Bindings that named it go too. Leaving them would make the model
    // unsaveable with an error about a member that is no longer on screen.
    patch({
      members: draft!.members.filter((m) => m.alias !== alias),
      sharedDimensions: draft!.sharedDimensions
        .map((shared) => ({
          ...shared,
          bindings: Object.fromEntries(
            Object.entries(shared.bindings).filter(([key]) => key !== alias),
          ),
          labels: Object.fromEntries(
            Object.entries(shared.labels ?? {}).filter(([key]) => key !== alias),
          ),
        }))
        .filter((shared) => Object.keys(shared.bindings).length > 0),
      derivedMetrics: draft!.derivedMetrics.filter(
        (metric) => !JSON.stringify(metric.expr).includes(`"${alias}:`),
      ),
    });
  }

  function renameMember(from: string, to: string) {
    const rename = (map: Record<string, Binding>) =>
      Object.fromEntries(
        Object.entries(map).map(([key, value]) => [key === from ? to : key, value]),
      );
    patch({
      members: draft!.members.map((m) => (m.alias === from ? { ...m, alias: to } : m)),
      sharedDimensions: draft!.sharedDimensions.map((shared) => ({
        ...shared,
        bindings: rename(shared.bindings),
        labels: shared.labels ? rename(shared.labels) : undefined,
      })),
    });
  }

  function addSharedDimension() {
    const shared: SharedDimension = {
      name: "",
      bindings: Object.fromEntries(aliases.map((alias) => [alias, emptyBinding()])),
    };
    patch({ sharedDimensions: [...draft!.sharedDimensions, shared] });
  }

  function patchShared(index: number, next: Partial<SharedDimension>) {
    patch({
      sharedDimensions: draft!.sharedDimensions.map((shared, i) =>
        i === index ? { ...shared, ...next } : shared,
      ),
    });
  }

  return (
    <div className="model-page">
      <header className="model-head">
        <label className="sr-only" htmlFor="model-name">
          Model name
        </label>
        <input
          id="model-name"
          className="model-name"
          value={draft.name}
          disabled={readOnly}
          maxLength={200}
          onChange={(event) => patch({ name: event.target.value })}
        />
        <div className="model-actions">
          <a className="link" href={`/api/composites/${id}/export`} download>
            Export
          </a>
          <button
            type="button"
            className="primary"
            disabled={readOnly || save.isPending}
            onClick={() => {
              setSaveError(null);
              save.mutate(draft);
            }}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {saveError && <p role="alert">{saveError}</p>}
      {readOnly && (
        <p className="tile-hint">Your access to this workspace is read-only.</p>
      )}

      <section className="model-section">
        <h3>Views in this model</h3>
        <p className="tile-hint">
          Each view keeps its own metrics and its own joins. A question is
          sent to whichever ones it actually asks something of.
        </p>
        {draft.members.length === 0 && (
          <p className="empty">No views yet. Add two to have something to join.</p>
        )}
        <ul className="model-members">
          {draft.members.map((member) => (
            <li key={`${member.database}.${member.schema}.${member.view}`}>
              <label className="sr-only" htmlFor={`alias-${member.alias}`}>
                Alias for {member.view}
              </label>
              <input
                id={`alias-${member.alias}`}
                className="model-alias"
                value={member.alias}
                disabled={readOnly}
                onChange={(event) => renameMember(member.alias, event.target.value)}
              />
              <span className="model-view-name">
                {member.database}.{member.schema}.{member.view}
              </span>
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Remove ${member.view}`}
                disabled={readOnly}
                onClick={() => removeMember(member.alias)}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
        <label className="sr-only" htmlFor="add-view">
          Add a view
        </label>
        <select
          id="add-view"
          value=""
          disabled={readOnly}
          onChange={(event) => {
            addMember(event.target.value);
            event.currentTarget.value = "";
          }}
        >
          <option value="">Add a view…</option>
          {(views.data?.views ?? [])
            .map((view) => `${view.database}.${view.schema}.${view.name}`)
            .filter(
              (name) =>
                !draft.members.some(
                  (m) => `${m.database}.${m.schema}.${m.view}` === name,
                ),
            )
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
      </section>

      <section className="model-section">
        <h3>What means the same thing</h3>
        <p className="tile-hint">
          The columns that let these views be asked one question. Nothing is
          guessed from a column name — two views spelling something the same
          way is a coincidence, not a mapping.
        </p>
        {draft.sharedDimensions.map((shared, index) => (
          <div className="model-shared" key={index}>
            <div className="model-shared-head">
              <label className="sr-only" htmlFor={`shared-${index}`}>
                What to call it
              </label>
              <input
                id={`shared-${index}`}
                placeholder="Customer"
                value={shared.name}
                disabled={readOnly}
                onChange={(event) => patchShared(index, { name: event.target.value })}
              />
              <button
                type="button"
                className="icon-button danger"
                aria-label={`Remove ${shared.name || "this dimension"}`}
                disabled={readOnly}
                onClick={() =>
                  patch({
                    sharedDimensions: draft.sharedDimensions.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            <table className="content-table">
              <thead>
                <tr>
                  <th>View</th>
                  <th>Table</th>
                  <th>Key column</th>
                </tr>
              </thead>
              <tbody>
                {draft.members.map((member) => {
                  const binding = shared.bindings[member.alias];
                  return (
                    <tr key={member.alias}>
                      <td>{member.alias}</td>
                      <td>
                        <input
                          aria-label={`Table for ${member.alias}`}
                          value={binding?.table ?? ""}
                          disabled={readOnly}
                          onChange={(event) =>
                            patchShared(index, {
                              bindings: {
                                ...shared.bindings,
                                [member.alias]: {
                                  table: event.target.value,
                                  column: binding?.column ?? "",
                                },
                              },
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Column for ${member.alias}`}
                          value={binding?.column ?? ""}
                          disabled={readOnly}
                          onChange={(event) =>
                            patchShared(index, {
                              bindings: {
                                ...shared.bindings,
                                [member.alias]: {
                                  table: binding?.table ?? "",
                                  column: event.target.value,
                                },
                              },
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        <button
          type="button"
          disabled={readOnly || draft.members.length < 2}
          onClick={addSharedDimension}
          title={
            draft.members.length < 2
              ? "Add a second view first — there is nothing to line up yet."
              : undefined
          }
        >
          Add a shared dimension
        </button>
      </section>

      <section className="model-section">
        <h3>How the views meet</h3>
        <div className="model-choices">
          <span className="field">
            <label htmlFor="join-type">Rows to keep</label>
            <select
              id="join-type"
              value={draft.joinType}
              disabled={readOnly}
              onChange={(event) =>
                patch({ joinType: event.target.value as "full" | "inner" })
              }
            >
              <option value="full">Everything either view knows about</option>
              <option value="inner">Only what every view knows about</option>
            </select>
          </span>
          <span className="field">
            <label htmlFor="cross-filter">A filter on one view</label>
            <select
              id="cross-filter"
              value={draft.crossFilter}
              disabled={readOnly}
              onChange={(event) =>
                patch({ crossFilter: event.target.value as "semi" | "local" })
              }
            >
              <option value="semi">Narrows the other views too</option>
              <option value="local">Applies to that view only</option>
            </select>
          </span>
        </div>
        <p className="tile-hint">
          {draft.crossFilter === "semi"
            ? "Filtering sales to Europe shows tickets for the customers that filter left — usually what people mean."
            : "Filtering sales to Europe leaves ticket counts global. Say so out loud, because the two answer differently."}
        </p>
      </section>

      <DerivedMetrics
        definition={draft}
        readOnly={readOnly}
        onChange={(derivedMetrics) => patch({ derivedMetrics })}
      />

      <ModelPreview id={id} definition={draft} />
    </div>
  );
}
