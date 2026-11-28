import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CoachLocale } from "./judge-types.ts";

export const SPEECH_KEY_MAX_LENGTH = 4096;
export const REGION_MAX_LENGTH = 64;
export const FIRST_LANGUAGE_MAX_LENGTH = 64;

export type StoredSettings = {
  azureSpeechKey?: string;
  azureRegion?: string;
  targetLanguage?: CoachLocale;
  firstLanguage?: string;
};

export type PublicSettings = {
  configured: boolean;
  region: string;
};

export type CoachProfile = {
  targetLanguage: CoachLocale;
  firstLanguage: string;
};

const DEFAULT_TARGET: CoachLocale = "en-US";

const settingsFile = (directory: string) => path.join(directory, "settings.json");

const REGION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/i;

export function normalizeRegion(input: string): string {
  const region = input.trim();
  if (!region) throw new Error("The Azure Speech region must not be blank.");
  if (region.length > REGION_MAX_LENGTH) throw new Error("The Azure Speech region is too long.");
  if (!REGION_PATTERN.test(region)) throw new Error("The Azure Speech region format is not valid.");
  return region;
}

export function readSpeechKey(input: unknown): string {
  if (!record(input) || typeof input.key !== "string") throw new Error("Expected an Azure Speech key.");
  const key = input.key.trim();
  if (!key) throw new Error("The Azure Speech key must not be blank.");
  if (key.length > SPEECH_KEY_MAX_LENGTH) throw new Error("The Azure Speech key is too long.");
  return key;
}

export function normalizeTargetLanguage(input: unknown): CoachLocale {
  if (input !== "en-US" && input !== "zh-CN") throw new Error("The target language must be en-US or zh-CN.");
  return input;
}

export function normalizeFirstLanguage(input: unknown): string {
  if (typeof input !== "string") throw new Error("Expected the learner first language.");
  const language = input.trim();
  if (!language) throw new Error("The learner first language must not be blank.");
  if (language.length > FIRST_LANGUAGE_MAX_LENGTH) throw new Error("The learner first language is too long.");
  return language;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadSettings(directory: string): StoredSettings {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(settingsFile(directory), "utf8"));
    if (!record(value)) return {};
    const settings: StoredSettings = {};
    if (typeof value.azureSpeechKey === "string") {
      const key = value.azureSpeechKey.trim();
      if (key && key.length <= SPEECH_KEY_MAX_LENGTH) settings.azureSpeechKey = key;
    }
    if (typeof value.azureRegion === "string") {
      const region = value.azureRegion.trim();
      if (region && region.length <= REGION_MAX_LENGTH && REGION_PATTERN.test(region)) settings.azureRegion = region;
    }
    if (value.targetLanguage === "en-US" || value.targetLanguage === "zh-CN") settings.targetLanguage = value.targetLanguage;
    if (typeof value.firstLanguage === "string") {
      const first = value.firstLanguage.trim();
      if (first && first.length <= FIRST_LANGUAGE_MAX_LENGTH) settings.firstLanguage = first;
    }
    return settings;
  } catch {
    return {};
  }
}

export function saveSettings(directory: string, settings: StoredSettings): void {
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

export function publicSettings(settings: StoredSettings): PublicSettings {
  return {
    configured: Boolean(settings.azureSpeechKey),
    region: settings.azureRegion ?? "",
  };
}

export function coachProfile(settings: StoredSettings): CoachProfile {
  return {
    targetLanguage: settings.targetLanguage ?? DEFAULT_TARGET,
    firstLanguage: settings.firstLanguage ?? "en",
  };
}