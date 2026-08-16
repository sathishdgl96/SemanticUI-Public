import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { askReport } from "../api/ask";
import { ApiError } from "../api/client";
import type { AskSpec } from "../api/types";
import ResultsTable from "../query/ResultsTable";
import SpecSummary from "./SpecSummary";

interface Props {
  reportId: string;
  canEdit: boolean;
  onAddVisual: (spec: AskSpec) => void;
  onClose: () => void;
}

export default function AskPanel({ reportId, canEdit, onAddVisual, onClose }: Props) {
  const questionId = useId();
  const [question, setQuestion] = useState("");

  const ask = useMutation({
    mutationFn: () => askReport(reportId, question.trim()),
  });

  return (
    <section className="ask-panel" aria-label="Ask a question">
      <header>
        <h3>Ask</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) ask.mutate();
        }}
      >
        <label htmlFor={questionId}>Question</label>
        <input
          id={questionId}
          value={question}
          maxLength={1000}
          placeholder="Which region had the most revenue last quarter?"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={!question.trim() || ask.isPending}>
          {ask.isPending ? "Asking…" : "Ask"}
        </button>
      </form>

      {ask.isPending && (
        <p className="tile-hint">
          Asking the model, then running the query it proposes on your own
          Snowflake connection…
        </p>
      )}

      {ask.isError && (
        <p role="alert">
          {ask.error instanceof ApiError
            ? ask.error.message
            : "Could not answer that question."}
        </p>
      )}

      {ask.data && (
        <div className="ask-answer">
          <p className="ask-explanation">{ask.data.explanation}</p>
          <ResultsTable result={ask.data} />
          <SpecSummary spec={ask.data.spec} />
          {canEdit && (
            <button type="button" onClick={() => onAddVisual(ask.data.spec)}>
              Add as visual
            </button>
          )}
        </div>
      )}
    </section>
  );
}
