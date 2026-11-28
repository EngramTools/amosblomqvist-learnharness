export type CoachLocale = "en-US" | "zh-CN";

/** Providers leave a score out when they do not measure it; a missing score is never a zero. */
export type AssessmentScores = {
  accuracy: number;
  fluency?: number;
  completeness?: number;
  prosody?: number;
};

export type PhonemeAssessment = {
  phoneme: string;
  score: number;
  heard: string[];
};

/** One initial, final or tone row of a Mandarin syllable as the provider scored it. */
export type SyllableUnitAssessment = {
  expected: string | number | null;
  heard: string | number | null;
  score: number | null;
  /** Provider verdict; act on this rather than on the score band. */
  decision: string | null;
};

export type SyllableAssessment = {
  syllable: string;
  pinyin: string;
  score: number;
  initial?: SyllableUnitAssessment;
  final?: SyllableUnitAssessment;
  tone?: SyllableUnitAssessment;
};

export type WordAssessment = {
  word: string;
  score: number;
};

export type AssessmentOk = {
  status: "ok";
  words: WordAssessment[];
  phonemes?: PhonemeAssessment[];
  syllables?: SyllableAssessment[];
  scores: AssessmentScores;
};

export type AssessmentUnavailable = {
  status: "unavailable";
  reason: string;
};

export type AssessmentResult = AssessmentOk | AssessmentUnavailable;

export interface PronunciationJudge {
  assess(clip: Uint8Array, referenceText: string, locale: CoachLocale): Promise<AssessmentResult>;
}