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
  return JSON.stringify(value).replace(/[^\u0020-\u007e]/gu, character => {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    const first = 0xd800 + ((code - 0x10000) >> 10);
    const second = 0xdc00 + ((code - 0x10000) & 0x3ff);
    return `\\u${first.toString(16).padStart(4, "0")}\\u${second.toString(16).padStart(4, "0")}`;
  });
}