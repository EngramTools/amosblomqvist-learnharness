export type CoachLocale = "en-US" | "zh-CN";

export type AssessmentScores = {
  accuracy: number;
  fluency: number;
  completeness: number;
  prosody?: number;
};

export type PhonemeAssessment = {
  phoneme: string;
  score: number;
  heard: string[];
};

export type SyllableAssessment = {
  syllable: string;
  pinyin: string;
  score: number;
};

export type WordAssessment = {
  word: string;
  score: number;
  /** Per-phoneme scores for this word, on ok en-US results. */
  phonemes?: PhonemeAssessment[];
  /** Per-syllable scores for this word, on ok zh-CN results. */
  syllables?: SyllableAssessment[];
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