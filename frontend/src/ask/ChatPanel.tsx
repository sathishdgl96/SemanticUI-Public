/** A conversation with the report, and a way to build it from one.
 *
 *  This replaces a one-shot question box. The difference that matters is not
 *  the bubbles: it is that each question is sent with the ones before it, so
 *  "now split that by region" is a question the model can answer. Without
 *  history every turn started from nothing and the only way to refine an
 *  answer was to retype it in full.
 *
 *  What travels back to the model is the QUESTION and the model's own
 *  one-sentence explanation -- never the rows. That rule is what makes this
 *  safe to point at a governed model, and a chat is where it would be
 *  easiest to break by accident.
 */

import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { askReport, type AskTurn } from "../api/ask";
import { ApiError } from "../api/client";
import type { AskResponse, AskSpec } from "../api/types";
import ResultsTable from "../query/ResultsTable";
import SpecSummary from "./SpecSummary";

interface Props {
  reportId: string;
  canEdit: boolean;
  onAddVisual: (spec: AskSpec) => void;
  onClose: () => void;
}

interface Message {
  id: number;
  question: string;
  /** Absent while the answer is still coming, or if it never came. */
  answer?: AskResponse;
  error?: string;
}

export default function ChatPanel({ reportId, canEdit, onAddVisual, onClose }: Props) {
  const questionId = useId();
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  // The newest turn is at the bottom, so the view follows it there. Feature
  // -checked rather than called blind: scrolling is a convenience, and a
  // runtime without it (jsdom, and any future non-DOM renderer) should get a
  // chat that does not scroll, not a chat that throws on its first render.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  const ask = useMutation({
    mutationFn: ({ text, history }: { text: string; history: AskTurn[] }) =>
      askReport(reportId, text, history),
  });

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    // Only ANSWERED turns become history: an unanswered question would tell
    // the model a thing was asked and leave it guessing what came of it.
    const history: AskTurn[] = messages
      .filter((m) => m.answer)
      .map((m) => ({ question: m.question, answer: m.answer!.explanation }));
    const id = messages.length;
    setMessages((prev) => [...prev, { id, question: trimmed }]);
    setQuestion("");
    ask.mutate(
      { text: trimmed, history },
      {
        onSuccess: (answer) =>
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, answer } : m)),
          ),
        onError: (error) =>
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? {
                    ...m,
                    error:
                      error instanceof ApiError
                        ? error.message
                        : "Could not answer that question.",
                  }
                : m,
            ),
          ),
      },
    );
  }

  return (
    <section className="chat-panel" aria-label="Chat">
      <header>
        <h3>Chat</h3>
        {/* An X, and a real one: the panel floats over the canvas rather than
            covering it, so closing has to be reachable without leaving what
            you were reading. */}
        <button
          type="button"
          className="icon-button"
          aria-label="Close chat"
          title="Close"
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div className="chat-log" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="tile-hint">
            Ask about this report's data in your own words — "revenue by region
            last quarter". Follow-ups work: "now split that by segment". Any
            answer can be added to the report as a visual.
          </p>
        )}
        {messages.map((message) => (
          <article key={message.id} className="chat-turn">
            <p className="chat-question">{message.question}</p>
            {message.error ? (
              <p role="alert" className="chat-answer">
                {message.error}
              </p>
            ) : message.answer ? (
              <div className="chat-answer">
                <p className="ask-explanation">{message.answer.explanation}</p>
                <ResultsTable result={message.answer} />
                {/* The spec, every time. A number from a language model is
                    worth what your ability to check it is worth. */}
                <details className="chat-audit">
                  <summary>How this was answered</summary>
                  <SpecSummary spec={message.answer.spec} />
                  <pre>{message.answer.sql}</pre>
                </details>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onAddVisual(message.answer!.spec)}
                  >
                    Add to report
                  </button>
                )}
              </div>
            ) : (
              <p className="chat-answer tile-hint">
                Asking the model, then running the query it proposes on your own
                Snowflake connection…
              </p>
            )}
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send(question);
        }}
      >
        <label className="sr-only" htmlFor={questionId}>
          Message
        </label>
        <input
          id={questionId}
          value={question}
          maxLength={1000}
          autoComplete="off"
          placeholder="Ask about this data…"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" disabled={!question.trim() || ask.isPending}>
          {ask.isPending ? "Asking…" : "Send"}
        </button>
      </form>
    </section>
  );
}
