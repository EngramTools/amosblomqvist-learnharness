import type { CoachLocale } from "./judge-types.ts";

type PronunciationHeader = {
  ReferenceText: string;
  GradingSystem: "HundredMark";
  Granularity: "Phoneme";
  Dimension: "Comprehensive";
  EnableMiscue: boolean;
  PhonemeAlphabet: "IPA";
  NBestPhonemeCount: number;
  EnableProsodyAssessment?: boolean;
};

export function buildPronunciationAssessmentHeader(referenceText: string, locale: CoachLocale): string {
  const header: PronunciationHeader = {
    ReferenceText: referenceText,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: true,
    PhonemeAlphabet: "IPA",
    NBestPhonemeCount: 5,
  };
  if (locale === "en-US") header.EnableProsodyAssessment = true;
  return toAsciiJson(header);
}

/** HTTP headers must stay ASCII; Azure accepts JSON with \\u escapes in ReferenceText. */
function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\u0020-\u007e]/g, character => {
    const code = character.charCodeAt(0);
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    const first = character.charCodeAt(0);
    const second = character.charCodeAt(1);
    const combined = (first - 0xd800) * 0x400 + (second - 0xdc00) + 0x10000;
    return `\\u${combined.toString(16).padStart(4, "0")}`;
  });
}