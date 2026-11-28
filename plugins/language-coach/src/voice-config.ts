import type { CoachLocale } from "./judge-types.ts";

export const DEFAULT_EN_VOICE = "en-US-JennyNeural";
export const DEFAULT_ZH_VOICE = "zh-CN-XiaoxiaoNeural";
export const VOICE_MAX_LENGTH = 128;

const VOICE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+Neural$/;

export function defaultVoice(locale: CoachLocale): string {
  return locale === "zh-CN" ? DEFAULT_ZH_VOICE : DEFAULT_EN_VOICE;
}

function isVoiceForLocale(voice: string, locale: CoachLocale): boolean {
  return voice.startsWith(`${locale}-`)
    && voice.length <= VOICE_MAX_LENGTH
    && VOICE_PATTERN.test(voice);
}

/** A blank voice resets to the locale default; anything else must be an Azure voice for that locale. */
export function normalizeVoice(input: unknown, locale: CoachLocale): string {
  if (typeof input !== "string") throw new Error("Expected a reference voice name.");
  const voice = input.trim();
  if (!voice) return defaultVoice(locale);
  if (!isVoiceForLocale(voice, locale)) {
    throw new Error(`The reference voice must be an Azure ${locale} neural voice name.`);
  }
  return voice;
}

/** Invalid stored values fall back to the default rather than failing activation. */
export function storedVoice(value: unknown, locale: CoachLocale): string | undefined {
  if (typeof value !== "string") return undefined;
  const voice = value.trim();
  return isVoiceForLocale(voice, locale) ? voice : undefined;
}
