import { randomUUID } from "node:crypto";
import type {
  AssessmentOk,
  AssessmentResult,
  AssessmentScores,
  CoachLocale,
  PronunciationJudge,
  SyllableAssessment,
  SyllableUnitAssessment,
  WordAssessment,
} from "./judge-types.ts";

/** One short clip per assessment; stall must not hold the UI open. */
export const TONEPERFECT_ASSESS_TIMEOUT_MS = 15_000;
export const TONEPERFECT_ENDPOINT = "https://api.toneperfect.app";

const UNEXPECTED_PAYLOAD = "TonePerfect returned an unexpected pronunciation payload.";
const UNREADABLE_PAYLOAD = "TonePerfect returned an unreadable pronunciation payload.";
const UNREACHABLE = "TonePerfect pronunciation assessment could not be reached.";
const TIMED_OUT = "TonePerfect pronunciation assessment timed out.";
const NO_KEY = "Add a TonePerfect key in Language coach settings.";

export type TonePerfectJudgeOptions = {
  apiKey: string;
  endpointBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type TonePerfectJudgeRuntime = Pick<TonePerfectJudgeOptions, "endpointBase" | "timeoutMs" | "fetch">;

type Entry = Record<string, unknown>;
type SyllableDimension = "initial" | "final" | "tone";

class PayloadError extends Error {
  constructor() {
    super(UNEXPECTED_PAYLOAD);
  }
}

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): Entry[] {
  return Array.isArray(value) ? value.filter(record) : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unitValue(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isDimension(value: unknown): value is SyllableDimension {
  return value === "initial" || value === "final" || value === "tone";
}

function requiredScore(value: unknown): number {
  const score = readNumber(value);
  if (score === undefined) throw new PayloadError();
  return score;
}

function mapUnit(phone: Entry): SyllableUnitAssessment {
  return {
    expected: unitValue(phone.expected),
    heard: unitValue(phone.heard),
    score: readNumber(phone.score) ?? null,
    decision: nullableText(phone.decision),
  };
}

/** Keep the first row per dimension; later inserted-consonant rows are additions, not replacements. */
function applyUnit(syllable: SyllableAssessment, phone: Entry): void {
  const { dimension } = phone;
  if (!isDimension(dimension) || syllable[dimension]) return;
  syllable[dimension] = mapUnit(phone);
}

function mapSyllable(word: Entry): SyllableAssessment {
  const syllable: SyllableAssessment = {
    syllable: text(word.word),
    pinyin: text(word.pinyin),
    score: requiredScore(word.score),
  };
  for (const phone of records(word.phones)) applyUnit(syllable, phone);
  return syllable;
}

function mapWord(word: Entry): WordAssessment {
  return { word: text(word.word), score: requiredScore(word.score) };
}

function mapScores(source: unknown): AssessmentScores {
  const entry = record(source) ? source : {};
  const accuracy = readNumber(entry.pronunciation) ?? readNumber(entry.overall);
  if (accuracy === undefined) throw new PayloadError();
  const scores: AssessmentScores = { accuracy };
  const fluency = readNumber(entry.fluency);
  if (fluency !== undefined) scores.fluency = fluency;
  const completeness = readNumber(entry.integrity);
  if (completeness !== undefined) scores.completeness = completeness;
  return scores;
}

function unassessableReason(reason: unknown): string {
  const detail = text(reason).trim() || "no reason given";
  return `TonePerfect could not assess the recording: ${detail}.`;
}

function mapBody(body: unknown, locale: CoachLocale): AssessmentResult {
  if (!record(body)) throw new PayloadError();
  if (body.assessable === false) return { status: "unavailable", reason: unassessableReason(body.reason) };
  if (body.assessable !== true) throw new PayloadError();
  const words = records(body.words);
  const result: AssessmentOk = { status: "ok", words: words.map(mapWord), scores: mapScores(body.scores) };
  if (locale === "zh-CN") result.syllables = words.map(mapSyllable);
  return result;
}

/** Maps a TonePerfect response to an assessment, or to the reason it could not assess the clip. */
export function mapTonePerfectResponse(body: unknown, locale: CoachLocale): AssessmentResult {
  try {
    return mapBody(body, locale);
  } catch (error) {
    if (error instanceof PayloadError) return { status: "unavailable", reason: UNEXPECTED_PAYLOAD };
    throw error;
  }
}

function unavailable(reason: string): AssessmentResult {
  return { status: "unavailable", reason };
}

function multipartBody(clip: Uint8Array, referenceText: string, locale: CoachLocale): FormData {
  const form = new FormData();
  form.append("audio", new Blob([Uint8Array.from(clip)], { type: "audio/wav" }), "clip.wav");
  form.append("text", referenceText);
  form.append("language", locale);
  return form;
}

type ErrorDetail = { code?: string; message?: string };

function readErrorDetail(error: unknown): ErrorDetail {
  if (!record(error)) return {};
  return { code: nullableText(error.code) ?? undefined, message: nullableText(error.message) ?? undefined };
}

/** The provider's error code is the stable part; its message is only extra context. */
async function failureReason(response: Response): Promise<string> {
  let detail: ErrorDetail = {};
  try {
    const body: unknown = await response.json();
    if (record(body)) detail = readErrorDetail(body.error);
  } catch { /* the status is still readable */ }
  const parts = [detail.code, detail.message].filter((part): part is string => Boolean(part));
  const suffix = parts.length ? `: ${parts.join(": ")}` : "";
  return `TonePerfect pronunciation assessment failed (${response.status}${suffix}).`;
}

async function readAssessment(response: Response, locale: CoachLocale, timedOut: boolean): Promise<AssessmentResult> {
  if (!response.ok) return unavailable(await failureReason(response));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailable(timedOut ? TIMED_OUT : UNREADABLE_PAYLOAD);
  }
  return mapTonePerfectResponse(body, locale);
}

type AssessmentRequest = {
  http: typeof fetch;
  key: string;
  endpoint: string;
  timeoutMs: number;
  clip: Uint8Array;
  referenceText: string;
  locale: CoachLocale;
};

function requestHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Idempotency-Key": randomUUID(),
    Accept: "application/json",
  };
}

async function performAssessment(request: AssessmentRequest): Promise<AssessmentResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await request.http(request.endpoint, {
      method: "POST",
      headers: requestHeaders(request.key),
      body: multipartBody(request.clip, request.referenceText, request.locale),
      signal: controller.signal,
    }).catch(() => null);
    if (!response) return unavailable(timedOut ? TIMED_OUT : UNREACHABLE);
    return await readAssessment(response, request.locale, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

export function createTonePerfectJudge(options: TonePerfectJudgeOptions): PronunciationJudge {
  const timeoutMs = options.timeoutMs ?? TONEPERFECT_ASSESS_TIMEOUT_MS;
  const http = options.fetch ?? fetch;
  const base = (options.endpointBase ?? TONEPERFECT_ENDPOINT).replace(/\/+$/, "");
  const endpoint = `${base}/v1/assess`;
  return {
    async assess(clip, referenceText, locale) {
      const key = options.apiKey.trim();
      if (!key) return unavailable(NO_KEY);
      return performAssessment({ http, key, endpoint, timeoutMs, clip, referenceText, locale });
    },
  };
}

/** Direct entry for tests and callers that already hold credentials. */
export async function assess(
  clip: Uint8Array,
  referenceText: string,
  locale: CoachLocale,
  options: TonePerfectJudgeOptions,
): Promise<AssessmentResult> {
  return createTonePerfectJudge(options).assess(clip, referenceText, locale);
}
