import type { PluginBackendContext, PluginQuestionGradingContext, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import type { AssessmentResult, CoachLocale } from "./judge-types.ts";
import { assess, createAzureJudge, type AzureJudgeRuntime } from "./azure-judge.ts";
import { RECORDING_LIMIT_MS } from "./recorder.ts";
import { definition as readAloudDefinition, type ReadAloudAnswer, type ReadAloudPayload } from "./read-aloud-contract.ts";
import { gradeReadAloud, splitWords } from "./read-aloud-grade.ts";
import { readAloudInstructions } from "./read-aloud-contract.ts";
import {
  loadSettings,
  normalizeFirstLanguage,
  normalizeRegion,
  normalizeTargetLanguage,
  coachProfile,
  publicSettings,
  readSpeechKey,
  saveSettings,
  type CoachProfile,
  type PublicSettings,
  type StoredSettings,
} from "./settings-store.ts";

export type LanguageCoachBackendOptions = {
  judge?: AzureJudgeRuntime;
};

/** 30 s of 16 kHz mono 16-bit PCM plus the WAV header. */
const MAX_CLIP_BYTES = (RECORDING_LIMIT_MS / 1000) * 16_000 * 2 + 44;
/** One capture quantum (4096 frames) can still land after the limit timer stopped the recorder. */
const CAPTURE_QUANTUM_BYTES = 4096 * 2;
const MAX_REQUEST_CLIP_BYTES = MAX_CLIP_BYTES + CAPTURE_QUANTUM_BYTES;
/** Azure assesses at most 30 s of speech, so a longer reference text can never be read in one clip. */
const REFERENCE_TEXT_MAX_LENGTH = 500;

const CLIP_EMPTY = "The recorded clip is empty.";
const CLIP_TOO_LONG = "The recorded clip is longer than the 30-second limit.";
const MAX_BASE64_LENGTH = Math.ceil(MAX_REQUEST_CLIP_BYTES / 3) * 4;

function readWavBase64(input: unknown): string {
  if (!record(input) || typeof input.wavBase64 !== "string") throw new Error("Expected a recorded WAV clip.");
  const trimmed = input.wavBase64.trim();
  if (!trimmed) throw new Error(CLIP_EMPTY);
  if (trimmed.length > MAX_BASE64_LENGTH) throw new Error(CLIP_TOO_LONG);
  return trimmed;
}

function decodeClip(input: unknown): Uint8Array {
  const bytes = Buffer.from(readWavBase64(input), "base64");
  if (!bytes.length) throw new Error(CLIP_EMPTY);
  if (bytes.length > MAX_REQUEST_CLIP_BYTES) throw new Error(CLIP_TOO_LONG);
  return new Uint8Array(bytes);
}

function readReferenceText(input: unknown): string {
  if (!record(input) || typeof input.referenceText !== "string") throw new Error("Expected reference text.");
  const text = input.referenceText.trim();
  if (!text) throw new Error("The reference text must not be blank.");
  if (text.length > REFERENCE_TEXT_MAX_LENGTH) {
    throw new Error(`The reference text must be at most ${REFERENCE_TEXT_MAX_LENGTH} characters.`);
  }
  return text;
}

function readLocale(input: unknown, settings: StoredSettings): CoachLocale {
  if (record(input) && input.locale !== undefined) return normalizeTargetLanguage(input.locale);
  return settings.targetLanguage ?? "en-US";
}

/** Decode and bound a saved read-aloud recording exactly like an assess-pronunciation clip. */
function readRecording(answer: unknown): Uint8Array {
  if (!record(answer) || typeof answer.recording !== "string") throw new Error("Expected a recorded WAV clip.");
  const bytes = Buffer.from(answer.recording.trim(), "base64");
  if (!bytes.length) throw new Error(CLIP_EMPTY);
  if (bytes.length > MAX_REQUEST_CLIP_BYTES) throw new Error(CLIP_TOO_LONG);
  return new Uint8Array(bytes);
}

/** The registered read-aloud question: gradeAnswer runs the pronunciation judge
 *  on the saved recording and merges per-sound results with dictionary expectations. */
export function readAloudQuestionType(runtime: AzureJudgeRuntime, settings: () => StoredSettings): PluginQuestionTypeDefinition {
  return {
    ...readAloudDefinition,
    gradeAnswer: async (context: PluginQuestionGradingContext<unknown, unknown>) => {
      const gradingContext = context as unknown as PluginQuestionGradingContext<ReadAloudPayload, ReadAloudAnswer>;
      gradingContext.signal.throwIfAborted();
      const locale = normalizeTargetLanguage(gradingContext.input.payload.language);
      const text = splitWords(gradingContext.input.payload.text).join(" ");
      if (!text) throw new Error("The drill text must contain at least one word.");
      const clip = readRecording(gradingContext.answer);
      const judged = await judgeFor(settings(), runtime).assess(clip, text, locale);
      return gradeReadAloud(text, locale, judged);
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function judgeFor(settings: StoredSettings, runtime?: AzureJudgeRuntime) {
  const key = settings.azureSpeechKey ?? "";
  const region = settings.azureRegion ?? "";
  return createAzureJudge({ subscriptionKey: key, region, ...runtime });
}

/** Apply only the fields the caller sent, validating each one. */
function mergeSettings(settings: StoredSettings, input: Record<string, unknown>): StoredSettings {
  const next: StoredSettings = { ...settings };
  if (input.key !== undefined) next.azureSpeechKey = readSpeechKey(input);
  if (typeof input.region === "string") next.azureRegion = normalizeRegion(input.region);
  if (input.targetLanguage !== undefined) next.targetLanguage = normalizeTargetLanguage(input.targetLanguage);
  if (input.firstLanguage !== undefined) next.firstLanguage = normalizeFirstLanguage(input.firstLanguage);
  return next;
}

export function activate(ctx: PluginBackendContext, options: LanguageCoachBackendOptions = {}): () => void {
  const settings = loadSettings(ctx.dataDirectory);
  let disposed = false;
  const assertActive = () => {
    if (disposed || ctx.signal.aborted) throw new Error("Language coach is disabled.");
  };

  const get = ctx.handle("get-settings", () => {
    assertActive();
    return publicSettings(settings);
  });

  const getProfile = ctx.handle("get-coach-profile", () => {
    assertActive();
    return coachProfile(settings);
  });

  const save = ctx.handle("save-settings", input => {
    assertActive();
    if (!record(input)) throw new Error("Expected language coach settings.");
    const next = mergeSettings(settings, input);
    saveSettings(ctx.dataDirectory, next);
    Object.assign(settings, next);
    const published: PublicSettings = publicSettings(settings);
    ctx.events.emit("settings-changed", { ...published, ...coachProfile(settings) });
    return { ...published, ...coachProfile(settings) };
  });

  const assessClip = ctx.handle("assess-pronunciation", async (input): Promise<AssessmentResult> => {
    assertActive();
    const clip = decodeClip(input);
    const referenceText = readReferenceText(input);
    const locale = readLocale(input, settings);
    return judgeFor(settings, options.judge).assess(clip, referenceText, locale);
  });

  const judgeRuntime = options.judge ?? {};
  let registeredQuestion: () => void;
  try {
    const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: readAloudInstructions });
    const unregisterQuestion = ctx.registerQuestionType(readAloudQuestionType(judgeRuntime, () => settings));
    registeredQuestion = () => {
      unregisterInstructions();
      unregisterQuestion();
    };
  } catch (error) {
    get();
    getProfile();
    save();
    assessClip();
    throw error;
  }

  return () => {
    if (disposed) return;
    disposed = true;
    get();
    getProfile();
    save();
    assessClip();
    registeredQuestion();
  };
}

export { assess };