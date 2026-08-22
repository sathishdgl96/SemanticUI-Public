import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ViewRef } from "../api/types";
import { getCertification, putCertification } from "../api/provenance";

/** Trim to null, because an empty box and an absent owner are the same
 *  thing and only one of them should reach the database. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Certifying a model, for whoever Snowflake says may.
 *
 * `canCertify` is the server's answer to one question asked on the caller's
 * own connection -- does this session hold the role that owns the view --
 * so the control appears for exactly the people the PUT would accept. When
 * it does not appear, the reason is said out loud: a control that silently
 * is not there reads as a missing feature rather than as a permission.
 */
export default function CertifyPanel({ view }: { view: ViewRef }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");

  const record = useQuery({
    queryKey: ["certification", view.database, view.schema, view.name],
    queryFn: () => getCertification(view),
    retry: false,
  });

  const save = useMutation({
    mutationFn: (certified: boolean) =>
      putCertification(view, {
        certified,
        ownerName: orNull(owner),
        ownerContact: orNull(contact),
        note: orNull(note),
      }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["certification"] });
      // The About page reads certification through its own endpoint, so it
      // has to be told too or the badge stays stale under the reader's eyes.
      queryClient.invalidateQueries({ queryKey: ["provenance"] });
    },
  });

  if (record.isLoading || !record.data) return null;
  const current = record.data;

  if (!current.canCertify) {
    return (
      <p className="about-cert-denied">
        Only the Snowflake role that owns this model can certify it.
      </p>
    );
  }

  const open = () => {
    // Prefilled from what is on record: re-certifying should not mean
    // retyping what was already true.
    setOwner(current.owner.name ?? "");
    setContact(current.owner.contact ?? "");
    setNote(current.note ?? "");
    setEditing(true);
  };

  if (!editing) {
    return (
      <p className="about-cert-actions">
        <button type="button" className="secondary" onClick={open}>
          {current.certified ? "Edit certification" : "Certify this model"}
        </button>
        {current.certified ? (
          <button
            type="button"
            className="link"
            disabled={save.isPending}
            onClick={() => {
              setOwner(current.owner.name ?? "");
              setContact(current.owner.contact ?? "");
              setNote(current.note ?? "");
              save.mutate(false);
            }}
          >
            Withdraw
          </button>
        ) : null}
      </p>
    );
  }

  return (
    <div className="about-cert-form">
      <label>
        Owner
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="The team or person to ask"
        />
      </label>
      <label>
        Contact
        <input
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          placeholder="Email, channel, or rota"
        />
      </label>
      <label>
        Note
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What this model is for"
        />
      </label>
      <p className="about-cert-actions">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate(true)}
        >
          Certify
        </button>
        <button type="button" className="link" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </p>
      {save.isError ? (
        <p className="about-cert-error" role="alert">
          {save.error instanceof Error
            ? save.error.message
            : "Could not save this certification."}
        </p>
      ) : null}
    </div>
  );
}
