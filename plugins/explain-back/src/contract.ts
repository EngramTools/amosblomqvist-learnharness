import type { PluginQuestionTypeDefinition } from "learnharness-plugin-api";

export const QUESTION_TYPE_ID = "explain-back";
export const RESULT_VERSION = 1;

export type ExplainBackPayload = {
  /** The reasoning step just taught, stated fully. */
  step: string;
  /** The facts the step rests on, as the teacher stated them. */
  premises: string[];
};

export type ExplainBackAnswer = {
  /** The learner's explanation, exactly as submitted or dictated. */
  text: string;
};

export const GAP_KINDS = ["missing step", "undefined term", "wrong order", "conclusion buried"] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export type ExplainBackGap = { kind: GapKind; detail: string };
export type ExplainBackResult = { version: typeof RESULT_VERSION; reconstruction: string; gaps: ExplainBackGap[] };

/**
 * The literal reader is deliberately not a tutor. It may only rebuild what the
 * learner's words establish; the step and premises are reference material for
 * finding gaps, never material it may add to the reconstruction.
 */
export const literalReaderInstructions = [
  "You are a literal reader. A learner has explained a reasoning step in their own words.",
  "Rebuild the step using only the learner's words. Never supply a premise, definition, connection, or intermediate conclusion the learner did not state, even when the step and its premises make it obvious.",
  "The step and its premises are reference material for finding gaps. They are never material you may add to the reconstruction.",
  "Do not be generous: if the learner's words do not establish something, it is not part of your reconstruction.",
  'When the learner\'s words establish nothing, return an empty reconstruction ("") and list the gaps.',
  "Record every gap you find. A gap's kind is exactly one of:",
  '- "missing step": the explanation omits a premise or the conclusion. Name the omitted premise or step in detail.',
  '- "undefined term": the explanation uses a term without defining it. Name the term in detail.',
  '- "wrong order": the explanation derives a fact before what it depends on. Name the ordering problem in detail.',
  '- "conclusion buried": the step\'s conclusion is present but not stated as the conclusion. Name it in detail.',
  "Return one JSON object and no prose:",
  '{"version":1,"reconstruction":"what the learner\'s words establish","gaps":[{"kind":"missing step","detail":"the omitted premise"}]}',
  "Use an empty gaps array when nothing is missing. Every detail must name the exact premise, term, ordering problem, or buried conclusion.",
].join("\n");

/** Readiness is not correctness; the answer is never trimmed. */
export function readAnswer(value: unknown): ExplainBackAnswer {
  if (!record(value) || typeof value.text !== "string" || !isReady(value.text)) {
    throw new Error("Explain-back answers must contain non-blank explanation text.");
  }
  return { text: value.text };
}

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "Explain-back check",
  contractVersion: 1,
  showThinking: false,
  questionSchema: {
    type: "object",
    properties: {
      step: {
        type: "string",
        pattern: "\\S",
        description: "The reasoning step just taught, stated fully in Markdown. The learner sees this step and explains it back in their own words.",
      },
      premises: {
        type: "array",
        items: { type: "string", pattern: "\\S" },
        description: "The facts the step rests on, each stated in its own sentence and in the order the step uses them, exactly as the teacher stated them. The literal reader reports any premise the learner leaves out.",
      },
    },
    required: ["step", "premises"],
    additionalProperties: false,
  },
  answerSchema: {
    type: "object",
    properties: {
      text: { type: "string", pattern: "\\S", description: "The learner's free-text explanation." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  teach: {
    toolName: "explain_back",
    description: "Ask the learner to explain a reasoning step back in their own words after teaching it. Put the step's full statement in payload.step and the facts it rests on in payload.premises, as the teacher stated them. The learner sees the step and writes a free-text explanation. On submission a literal reader rebuilds the step from the learner's words only and reports missing steps, undefined terms, wrong order, or a buried conclusion.",
  },
} satisfies PluginQuestionTypeDefinition;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReady(text: string): boolean {
  return /\S/.test(text);
}

/** Narrow the persisted plain-schema payload without a TypeBox-only static brand. */
export function readPayload(value: unknown): ExplainBackPayload {
  if (!record(value) || typeof value.step !== "string" || !isReady(value.step) || !Array.isArray(value.premises)) {
    throw new Error("Explain-back question payload is unavailable.");
  }
  if (!value.premises.every(premise => typeof premise === "string" && isReady(premise))) {
    throw new Error("Explain-back premises must be non-blank statements.");
  }
  return { step: value.step, premises: [...value.premises] as string[] };
}

export function isGapKind(value: unknown): value is GapKind {
  return typeof value === "string" && (GAP_KINDS as readonly string[]).includes(value);
}

function readGap(value: unknown): ExplainBackGap | null {
  if (!record(value) || !isGapKind(value.kind) || typeof value.detail !== "string" || !isReady(value.detail)) return null;
  return { kind: value.kind, detail: value.detail };
}

/** Validate a saved or model-produced result. Null means unreadable feedback. An empty reconstruction is valid: a fragmentary explanation can establish nothing. */
export function readExplainBackResult(value: unknown): ExplainBackResult | null {
  if (!record(value) || value.version !== RESULT_VERSION || typeof value.reconstruction !== "string" || !Array.isArray(value.gaps)) return null;
  const gaps: ExplainBackGap[] = [];
  for (const raw of value.gaps) {
    const gap = readGap(raw);
    if (!gap) return null;
    gaps.push(gap);
  }
  return { version: RESULT_VERSION, reconstruction: value.reconstruction, gaps };
}
