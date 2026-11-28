import type { PluginBackendContext } from "learnharness-plugin-api";
import type { AssessmentResult, CoachLocale } from "./judge-types.ts";
import { assess, createAzureJudge, type AzureJudgeRuntime } from "./azure-judge.ts";
import {
  loadSettings,
  normalizeFirstLanguage,
  normalizeRegion,
  normalizeTargetLanguage,
  publicSettings,
  readSpeechKey,
  saveSettings,
  type PublicSettings,
  type StoredSettings,
} from "./settings-store.ts";

export type LanguageCoachBackendOptions = {
  judge?: AzureJudgeRuntime;
};

function decodeClip(input: unknown): Uint8Array {
  if (!record(input) || typeof input.wavBase64 !== "string") throw new Error("Expected a recorded WAV clip.");
  const trimmed = input.wavBase64.trim();
  if (!trimmed) throw new Error("The recorded clip is empty.");
  const bytes = Buffer.from(trimmed, "base64");
  if (!bytes.length) throw new Error("The recorded clip is empty.");
  return new Uint8Array(bytes);
}

function readReferenceText(input: unknown): string {
  if (!record(input) || typeof input.referenceText !== "string") throw new Error("Expected reference text.");
  const text = input.referenceText.trim();
  if (!text) throw new Error("The reference text must not be blank.");
  return text;
}

function readLocale(input: unknown, settings: StoredSettings): CoachLocale {
  if (record(input) && input.locale !== undefined) return normalizeTargetLanguage(input.locale);
  return settings.targetLanguage ?? "en-US";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function judgeFor(settings: StoredSettings, runtime?: AzureJudgeRuntime) {
  const key = settings.azureSpeechKey ?? "";
  const region = settings.azureRegion ?? "";
  return createAzureJudge({ subscriptionKey: key, region, ...runtime });
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

  const save = ctx.handle("save-settings", input => {
    assertActive();
    if (!record(input)) throw new Error("Expected language coach settings.");
    const next: StoredSettings = { ...settings };
    if ("key" in input && input.key !== undefined) next.azureSpeechKey = readSpeechKey(input);
    if ("region" in input && typeof input.region === "string") next.azureRegion = normalizeRegion(input.region);
    if ("targetLanguage" in input && input.targetLanguage !== undefined) next.targetLanguage = normalizeTargetLanguage(input.targetLanguage);
    if ("firstLanguage" in input && input.firstLanguage !== undefined) next.firstLanguage = normalizeFirstLanguage(input.firstLanguage);
    saveSettings(ctx.dataDirectory, next);
    Object.assign(settings, next);
    const published: PublicSettings = publicSettings(settings);
    ctx.events.emit("settings-changed", published);
    return published;
  });

  const assessClip = ctx.handle("assess-pronunciation", async (input): Promise<AssessmentResult> => {
    assertActive();
    const clip = decodeClip(input);
    const referenceText = readReferenceText(input);
    const locale = readLocale(input, settings);
    return judgeFor(settings, options.judge).assess(clip, referenceText, locale);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    get();
    save();
    assessClip();
  };
}

export { assess };