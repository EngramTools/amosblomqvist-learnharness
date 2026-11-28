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
/** The four literal-reader gaps always score; the delivery criterion scores
 *  only on dictated interview-mode answers, so it stays optional here. */
export type ExplainBackCriterionScores = Record<GapKind, number> & { [DELIVERY_CRITERION]?: number };
/** `wording` is absent when the wording call failed; the scores still stand. */
export type ExplainBackFix = {
  criterion: GapKind | typeof DELIVERY_CRITERION;
  probability: number;
  wording?: string;
  /** Why the wording is absent; always paired with a missing `wording`. */
  unavailableReason?: string;
};
export type ExplainBackScoring =
  | { status: "ok"; criteria: ExplainBackCriterionScores; fix: ExplainBackFix }
  | { status: "unavailable"; reason: string };

/** Jev's fifth criterion, asked only when delivery metrics exist. */
export const DELIVERY_CRITERION = "filler rate high";
export type DeliveryPause = { afterWord: string; seconds: number };
export type DeliveryMetrics = { fillersPerMin: number; wordsPerMin: number; pauses: DeliveryPause[] };
export type ExplainBackDelivery =
  | { status: "ok"; fillersPerMin: number; wordsPerMin: number; pauses: DeliveryPause[] }
  | { status: "unavailable"; reason: string };

/** Per-dictation provenance, present on dictated answers only. An
 *  edit through `onChange` after the last dictation delivery marks the
 *  timing provenance lost: the text is no longer verbatim speech. */
export type DictationProvenance = { language: string; words: DeliveryWord[] };
export type DeliveryWord = { word: string; start: number; end: number; confidence: number };

export type ExplainBackResult = {
  version: typeof RESULT_VERSION;
  reconstruction: string;
  gaps: ExplainBackGap[];
  /** Absent only on results saved before scoring was added. */
  scoring?: ExplainBackScoring;
  /** Absent only on results saved before interview mode existed; every newer
   *  result carries it, as `unavailable` with a reason when metrics do not apply. */
  delivery?: ExplainBackDelivery;
  /** The model that ran the literal reader, as `provider/id`. Absent only on
   *  results saved before explain-back named the grading model. */
  gradedBy?: string;
};

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

/** Narrow dictated provenance; `undefined` means a typed answer. Words must
 *  carry finite, ordered `word`/`start`/`end`/`confidence` fields. */
export function readProvenance(value: unknown): DictationProvenance | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || typeof value.language !== "string" || !Array.isArray(value.words)) {
    throw new Error("Explain-back dictation provenance must carry a language and its words.");
  }
  const words: DeliveryWord[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const raw of value.words) {
    if (!record(raw) || typeof raw.word !== "string" || raw.word === "") throw new Error("Explain-back dictation words must be named.");
    if (!isFiniteNumber(raw.start) || !isFiniteNumber(raw.end) || !isFiniteNumber(raw.confidence) || raw.end < raw.start || raw.start < previousEnd) {
      throw new Error("Explain-back dictation word timings must be finite and ordered.");
    }
    previousEnd = raw.end;
    words.push({ word: raw.word, start: raw.start, end: raw.end, confidence: raw.confidence });
  }
  return { language: value.language, words };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
      language: { type: "string", description: "Dictation language code, present only on dictated answers." },
      words: {
        type: "array",
        items: {
          type: "object",
          properties: {
            word: { type: "string" },
            start: { type: "number" },
            end: { type: "number" },
            confidence: { type: "number" },
          },
          required: ["word", "start", "end", "confidence"],
          additionalProperties: false,
        },
        description: "Per-word timings of the dictation, in order, present only on dictated answers whose text is unedited.",
      },
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

function readCriterionScores(value: unknown): ExplainBackCriterionScores | null {
  if (!record(value)) return null;
  const known = Object.keys(value).filter(key => key !== DELIVERY_CRITERION);
  if (known.length !== GAP_KINDS.length) return null;
  const scores = {} as ExplainBackCriterionScores;
  for (const kind of GAP_KINDS) {
    const probability = value[kind];
    if (!isProbability(probability)) return null;
    scores[kind] = probability;
  }
  if (value[DELIVERY_CRITERION] !== undefined) {
    if (!isProbability(value[DELIVERY_CRITERION])) return null;
    scores[DELIVERY_CRITERION] = value[DELIVERY_CRITERION];
  }
  return scores;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readScoring(value: unknown): ExplainBackScoring | null {
  if (!record(value)) return null;
  if (value.status === "unavailable") {
    return typeof value.reason === "string" && isReady(value.reason) ? { status: "unavailable", reason: value.reason } : null;
  }
  if (value.status !== "ok") return null;
  const criteria = readCriterionScores(value.criteria);
  if (!criteria || !record(value.fix)) return null;
  const { criterion, probability, wording, unavailableReason } = value.fix;
  if (!isFixCriterion(criterion) || !isProbability(probability)) return null;
  const wordingValid = wording === undefined || (typeof wording === "string" && isReady(wording));
  if (!wordingValid) return null;
  const fix: ExplainBackFix = { criterion, probability };
  if (wording !== undefined) fix.wording = wording;
  else if (typeof unavailableReason === "string" && isReady(unavailableReason)) fix.unavailableReason = unavailableReason;
  return { status: "ok", criteria, fix };
}

/** The fix may name a literal-reader gap or the delivery criterion. */
function isFixCriterion(value: unknown): value is ExplainBackFix["criterion"] {
  return isGapKind(value) || value === DELIVERY_CRITERION;
}

/** Delivery is optional; present values must be fully readable or the saved result is rejected. */
function readDelivery(value: unknown): ExplainBackDelivery | null {
  if (!record(value)) return null;
  if (value.status === "unavailable") {
    return typeof value.reason === "string" && isReady(value.reason) ? { status: "unavailable", reason: value.reason } : null;
  }
  if (value.status !== "ok") return null;
  if (!isFiniteNumber(value.fillersPerMin) || !isFiniteNumber(value.wordsPerMin) || !Array.isArray(value.pauses)) return null;
  const pauses: DeliveryPause[] = [];
  for (const raw of value.pauses) {
    if (!record(raw) || typeof raw.afterWord !== "string" || raw.afterWord === "" || !isFiniteNumber(raw.seconds) || raw.seconds < 0) return null;
    pauses.push({ afterWord: raw.afterWord, seconds: raw.seconds });
  }
  return { status: "ok", fillersPerMin: value.fillersPerMin, wordsPerMin: value.wordsPerMin, pauses };
}

/** The grading model's `provider/id`, when a saved result carries a readable one. */
function readGradedBy(value: unknown): Pick<ExplainBackResult, "gradedBy"> {
  return typeof value === "string" && isReady(value) ? { gradedBy: value } : {};
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
  const scoring = value.scoring === undefined ? undefined : readScoring(value.scoring);
  if (value.scoring !== undefined && !scoring) return null;
  const delivery = value.delivery === undefined ? undefined : readDelivery(value.delivery);
  if (value.delivery !== undefined && !delivery) return null;
  const result: ExplainBackResult = { version: RESULT_VERSION, reconstruction: value.reconstruction, gaps };
  if (scoring) result.scoring = scoring;
  if (delivery) result.delivery = delivery;
  return { ...result, ...readGradedBy(value.gradedBy) };
}
