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
  // Azure's short-audio REST contract wants Base64-encoded UTF-8 JSON in this header.
  return Buffer.from(JSON.stringify(header), "utf8").toString("base64");
}