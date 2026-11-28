import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition } from "./contract.ts";
import { gradeExplainBack, type JevRuntime } from "./grader.ts";

export type ExplainBackBackendOptions = {
  /** Test-only transport override; the host always activates without it. */
  jev?: JevRuntime;
};

type Settings = { typesafeApiKey?: string; interviewMode?: boolean; pauseThresholdSeconds?: number };

type PublicSettings = { hasTypesafeKey: boolean; interviewMode: boolean; pauseThresholdSeconds: number };

/** Pause threshold bounds, in seconds; outside values are rejected. */
export const PAUSE_THRESHOLD_MIN_SECONDS = 0.5;
export const PAUSE_THRESHOLD_MAX_SECONDS = 10;
const DEFAULT_PAUSE_THRESHOLD_SECONDS = 2.0;

function readPauseThreshold(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < PAUSE_THRESHOLD_MIN_SECONDS || input > PAUSE_THRESHOLD_MAX_SECONDS) {
    throw new Error(`The pause threshold must be between ${PAUSE_THRESHOLD_MIN_SECONDS} and ${PAUSE_THRESHOLD_MAX_SECONDS} seconds.`);
  }
  return input;
}

const settingsFile = (directory: string) => path.join(directory, "settings.json");

const SETTINGS_FILE_DESCRIPTION = "the explain-back settings file";

function loadSettings(directory: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile(directory), "utf8");
  } catch (error) {
    // A missing settings file is the first-run case: an absent key store means no key.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
    // Never interpolate the read failure: its message can quote the settings
    // file (and therefore a stored key) into the activation error.
    throw new Error(`Could not read ${SETTINGS_FILE_DESCRIPTION}.`);
  }
  const value: unknown = parseJson(raw);
  if (!record(value)) throw new Error(`${SETTINGS_FILE_DESCRIPTION} is corrupt: it does not contain a settings object.`);
  const settings: Settings = {};
  if (typeof value.typesafeApiKey === "string") {
    const key = value.typesafeApiKey.trim();
    if (key) settings.typesafeApiKey = key;
  }
  if (typeof value.interviewMode === "boolean") settings.interviewMode = value.interviewMode;
  if (typeof value.pauseThresholdSeconds === "number" && Number.isFinite(value.pauseThresholdSeconds)
    && value.pauseThresholdSeconds >= PAUSE_THRESHOLD_MIN_SECONDS && value.pauseThresholdSeconds <= PAUSE_THRESHOLD_MAX_SECONDS) {
    settings.pauseThresholdSeconds = value.pauseThresholdSeconds;
  }
  return settings;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // JSON.parse's message can quote the corrupt source, including a stored
    // key; activation exposes only a generic corrupt-file message.
    throw new Error(`${SETTINGS_FILE_DESCRIPTION} is corrupt: it does not contain valid JSON.`);
  }
}

function saveSettings(directory: string, settings: Settings): void {
  const file = settingsFile(directory);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function publicSettings(settings: Settings): PublicSettings {
  return {
    hasTypesafeKey: Boolean(settings.typesafeApiKey),
    interviewMode: settings.interviewMode ?? false,
    pauseThresholdSeconds: settings.pauseThresholdSeconds ?? DEFAULT_PAUSE_THRESHOLD_SECONDS,
  };
}

/** Never echo the key, including from validation and transport failures. */
function readKey(input: unknown): string {
  if (!record(input) || typeof input.key !== "string") throw new Error("Expected a TypeSafe API key.");
  const key = input.key.trim();
  if (!key) throw new Error("The TypeSafe API key must not be blank.");
  if (key.length > 4096) throw new Error("The TypeSafe API key is too long.");
  return key;
}

export function activate(ctx: PluginBackendContext, options: ExplainBackBackendOptions = {}): () => void {
  const settings = loadSettings(ctx.dataDirectory);
  let disposed = false;
  const assertActive = () => {
    if (disposed || ctx.signal.aborted) throw new Error("Explain-back is disabled.");
  };
  const get = ctx.handle("get-settings", () => {
    assertActive();
    return publicSettings(settings);
  });
  const set = ctx.handle("set-typesafe-key", input => {
    assertActive();
    const key = readKey(input);
    saveSettings(ctx.dataDirectory, { ...settings, typesafeApiKey: key });
    settings.typesafeApiKey = key;
    const published = publicSettings(settings);
    ctx.events.emit("settings-changed", published);
    return published;
  });
  const isModeInput = (input: unknown): input is { mode: boolean } =>
    typeof input === "object" && input !== null && "mode" in input && typeof input.mode === "boolean";
  const isThresholdInput = (input: unknown): input is { seconds: unknown } =>
    typeof input === "object" && input !== null && "seconds" in input;
  const setInterviewMode = ctx.handle("set-interview-mode", input => {
    assertActive();
    if (!isModeInput(input)) throw new Error("Interview mode must be a boolean.");
    saveSettings(ctx.dataDirectory, { ...settings, interviewMode: input.mode });
    settings.interviewMode = input.mode;
    const published = publicSettings(settings);
    ctx.events.emit("settings-changed", published);
    return published;
  });
  const setPauseThreshold = ctx.handle("set-pause-threshold", input => {
    assertActive();
    if (!isThresholdInput(input)) throw new Error("Expected a pause threshold value.");
    const seconds = readPauseThreshold(input.seconds);
    saveSettings(ctx.dataDirectory, { ...settings, pauseThresholdSeconds: seconds });
    settings.pauseThresholdSeconds = seconds;
    const published = publicSettings(settings);
    ctx.events.emit("settings-changed", published);
    return published;
  });
  let unregister: () => void;
  try {
    unregister = ctx.registerQuestionType({
      ...definition,
      gradeAnswer: context => gradeExplainBack(ctx, context, {
        readTypesafeKey: () => settings.typesafeApiKey,
        interviewMode: settings.interviewMode ?? false,
        pauseThresholdSeconds: settings.pauseThresholdSeconds ?? DEFAULT_PAUSE_THRESHOLD_SECONDS,
        jev: options.jev,
      }),
    });
  } catch (error) {
    get(); set(); setInterviewMode(); setPauseThreshold();
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    unregister(); get(); set(); setInterviewMode(); setPauseThreshold();
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
