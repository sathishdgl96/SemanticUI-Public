import { apiFetch } from "./client";
import type { AskResponse } from "./types";

/** One earlier exchange, as the model is shown it.
 *
 *  `answer` is the explanation the model itself wrote, never the rows that
 *  came back. Keeping data out of the prompt is what makes this feature safe
 *  to point at a governed model, and a conversation is where it would be
 *  easiest to lose by accident. */
export interface AskTurn {
  question: string;
  answer: string;
}

export function askReport(
  reportId: string,
  question: string,
  history: AskTurn[] = [],
): Promise<AskResponse> {
  return apiFetch<AskResponse>(`/api/reports/${encodeURIComponent(reportId)}/ask`, {
    method: "POST",
    body: JSON.stringify({ question, history }),
  });
}
