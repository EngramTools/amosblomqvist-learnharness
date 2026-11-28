import type { AssessmentResult, CoachLocale, PhonemeAssessment, SyllableAssessment, WordAssessment } from "./judge-types.ts";
import { expectedPronunciation } from "./pronunciations.ts";
import { RESULT_VERSION, type ReadAloudResult, type WordScore } from "./read-aloud-contract.ts";

/** Learner-visible tokens: split on whitespace, keeping the written form for display. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(word => word !== "");
}

/** `WordAssessment` predates per-part scoring; the judge adds these fields on ok results. */

function judgedPhonemesOf(judged: WordAssessment | undefined): PhonemeAssessment[] {
  return judged && "phonemes" in judged && Array.isArray(judged.phonemes) ? (judged.phonemes as PhonemeAssessment[]) : [];
}

function judgedSyllablesOf(judged: WordAssessment | undefined): SyllableAssessment[] {
  return judged && "syllables" in judged && Array.isArray(judged.syllables) ? (judged.syllables as SyllableAssessment[]) : [];
}

/** Score one expected word against the judge's word entry, when one aligned to it. */
function scoreWord(word: string, locale: CoachLocale, judged: WordAssessment | undefined): WordScore {
  const expected = expectedPronunciation(word, locale);
  if (expected.kind === "missing") {
    return judged
      ? { word: judged.word, score: judged.score, noDictionaryPronunciation: true }
      : { word, score: 0, noDictionaryPronunciation: true };
  }
  const score = judged?.score ?? 0;
  if (expected.kind === "syllables") {
    const judgedSyllables = judgedSyllablesOf(judged);
    return {
      word,
      score,
      syllables: expected.pinyin.map((pinyin, index) => ({
        syllable: String(index + 1),
        pinyin,
        score: judgedSyllables[index]?.score ?? 0,
      })),
    };
  }
  const judgedPhonemes = judgedPhonemesOf(judged);
  return {
    word,
    score,
    phonemes: expected.ipa.map((phoneme, index) => ({
      phoneme,
      score: judgedPhonemes[index]?.score ?? 0,
      heard: judgedPhonemes[index]?.heard[0] ?? phoneme,
    })),
  };
}

/** Grade one recorded clip: align the judge's words with the dictionary's
 *  expected pronunciations. Never consults a model. */
export function gradeReadAloud(text: string, locale: CoachLocale, judge: AssessmentResult): ReadAloudResult {
  if (judge.status === "unavailable") return judge;
  const words = splitWords(text);
  return {
    status: "ok",
    words: words.map((word, index) => scoreWord(word, locale, judge.words[index])),
  };
}

/** The saved result version, re-exported for renderer tests. */
export const READ_ALOUD_RESULT_VERSION = RESULT_VERSION;
