import { DELIVERY_CRITERION, GAP_KINDS, type DeliveryMetrics, type ExplainBackGap, type GapKind } from "./contract.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** One Jev request per answer; a stalled request must not hold grading open. */
export const JEV_TIMEOUT_MS = 15_000;
const FIX_QUESTION = "fix";

export type JevState = {
  step: string;
  premises: string[];
  explanation: string;
  reconstruction: string;
  gaps: ExplainBackGap[];
  /** Present only when interview mode produced delivery metrics; Jev's
   *  "filler rate high" criterion is asked only over this state. */
  metrics?: DeliveryMetrics;
};

/** Every criterion the fix choice may pick, in a stable order: the four
 *  literal-reader gaps, plus filler rate only when metrics exist. */
export function jevCriteria(metrics: DeliveryMetrics | undefined): readonly JevCriterion[] {
  return metrics ? [...GAP_KINDS, DELIVERY_CRITERION] : GAP_KINDS;
}

/** Jev's fifth criterion, asked only when delivery metrics exist. */
export type JevCriterion = GapKind | typeof DELIVERY_CRITERION;

export type JevScores = {
  /** The versioned model that answered, for example "jev-1.14.0". */
  model: string;
  criteria: Record<GapKind, number> & { [DELIVERY_CRITERION]?: number };
  fix: { criterion: JevCriterion; probability: number };
};

export type JevOptions = {
  apiKey: string;
  endpoint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** Jev failures are expected outcomes, not grading failures: callers mark scoring unavailable. */
export class JevUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevUnavailableError";
  }
}

const NOUL_INSTRUCTIONS: Record<JevCriterion, string> = {
  "missing step": "Does the learner's explanation omit a premise or the step's conclusion?",
  "undefined term": "Does the learner's explanation use a term without defining it?",
  "wrong order": "Does the learner's explanation derive a fact before what it depends on?",
  "conclusion buried": "Is the step's conclusion present in the explanation but not stated as the conclusion?",
  [DELIVERY_CRITERION]: "Does the dictated delivery — filler words or long pauses — distract from the explanation's content?",
};

const FIX_CRITERIA: Record<JevCriterion, string> = {
  "missing step": "A premise or the conclusion is omitted.",
  "undefined term": "A term is used without being defined.",
  "wrong order": "A fact is derived before what it depends on.",
  "conclusion buried": "The conclusion is present but not stated as the conclusion.",
  [DELIVERY_CRITERION]: "Spoken delivery got in the way: many filler words or long pauses distract from the explanation.",
};

export type JevNoulQuestion = { type: "noul"; instructions: string };
export type JevChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<JevCriterion, string> };
export type JevRequest = { model: string; state: JevState; questions: Record<string, JevNoulQuestion | JevChoiceQuestion> };

export function buildJevRequest(state: JevRequest["state"]): JevRequest {
  const criteria = jevCriteria(state.metrics);
  const questions: JevRequest["questions"] = {};
  for (const kind of GAP_KINDS) questions[kind] = { type: "noul", instructions: NOUL_INSTRUCTIONS[kind] };
  if (state.metrics) questions[DELIVERY_CRITERION] = { type: "noul", instructions: NOUL_INSTRUCTIONS[DELIVERY_CRITERION] };
  questions[FIX_QUESTION] = {
    type: "choice",
    instructions: "Which single gap should the learner fix first in their next explanation?",
    criteria: criteria.reduce<Record<JevCriterion, string>>((map, kind) => {
      map[kind] = FIX_CRITERIA[kind];
      return map;
    }, {} as Record<JevCriterion, string>),
  };
  return {
    model: JEV_MODEL,
    state: {
      ...state,
      premises: [...state.premises],
      gaps: state.gaps.map(gap => ({ ...gap })),
      ...(state.metrics ? { metrics: { ...state.metrics, pauses: state.metrics.pauses.map(pause => ({ ...pause })) } } : {}),
    },
    questions,
  };
}

/** Ask Jev for criterion probabilities and the one fix to apply next. */
export async function scoreExplainBack(state: JevState, options: JevOptions): Promise<JevScores> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await sendRequest(state, options, controller.signal).catch(error => {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timedOut) throw new JevUnavailableError("Jev timed out before answering.");
      if (error instanceof JevUnavailableError) throw error;
      throw new JevUnavailableError("Jev could not be reached.");
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new JevUnavailableError(httpReason(response.status));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timedOut) throw new JevUnavailableError("Jev timed out before answering.");
      throw new JevUnavailableError("Jev returned an unreadable response.");
    }
    return readResponse(body);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    await response.arrayBuffer().catch(() => {});
  }
}

function sendRequest(state: JevState, options: JevOptions, signal: AbortSignal): Promise<Response> {
  return (options.fetch ?? fetch)(options.endpoint ?? JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildJevRequest(state)),
    signal,
  });
}

function httpReason(status: number): string {
  if (status === 429) return "Jev is rate limiting requests (HTTP 429).";
  if (status === 529) return "Jev is overloaded (HTTP 529).";
  if (status >= 500) return `Jev is unavailable (HTTP ${status}).`;
  return `Jev rejected the request (HTTP ${status}).`;
}

function readResponse(value: unknown): JevScores {
  if (!record(value) || typeof value.model !== "string" || value.model.trim() === "") throw unreadable();
  if (!record(value.answers)) throw unreadable();
  const criteria = {} as Record<GapKind, number>;
  for (const kind of GAP_KINDS) {
    const answer = value.answers[kind];
    if (!record(answer) || answer.type !== "noul") throw unreadable();
    criteria[kind] = probability(answer.noul);
  }
  const fixAnswer = value.answers[FIX_QUESTION];
  if (!record(fixAnswer) || fixAnswer.type !== "choice" || !isJevCriterion(fixAnswer.choice)) throw unreadable();
  if (!record(fixAnswer.probabilities)) throw unreadable();
  const chosen = probability(fixAnswer.probabilities[fixAnswer.choice]);
  const delivery = value.answers[DELIVERY_CRITERION];
  if (delivery !== undefined) {
    if (!record(delivery) || delivery.type !== "noul") throw unreadable();
    (criteria as Record<JevCriterion, number>)[DELIVERY_CRITERION] = probability(delivery.noul);
  }
  return { model: value.model, criteria, fix: { criterion: fixAnswer.choice, probability: chosen } };
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw unreadable();
  return value;
}

function isGapKind(value: unknown): value is GapKind {
  return typeof value === "string" && (GAP_KINDS as readonly string[]).includes(value);
}

function isJevCriterion(value: unknown): value is JevCriterion {
  return isGapKind(value) || value === DELIVERY_CRITERION;
}

function unreadable(): JevUnavailableError {
  return new JevUnavailableError("Jev returned an unreadable response.");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
