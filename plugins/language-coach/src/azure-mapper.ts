import type {
  AssessmentOk,
  AssessmentScores,
  CoachLocale,
  PhonemeAssessment,
  SyllableAssessment,
  WordAssessment,
} from "./judge-types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readScore(value: unknown): number | undefined {
  if (!record(value)) return undefined;
  const score = value.AccuracyScore;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function mapScores(pronunciation: Record<string, unknown>): AssessmentScores {
  const scores: AssessmentScores = {
    accuracy: typeof pronunciation.AccuracyScore === "number" ? pronunciation.AccuracyScore : 0,
    fluency: typeof pronunciation.FluencyScore === "number" ? pronunciation.FluencyScore : 0,
    completeness: typeof pronunciation.CompletenessScore === "number" ? pronunciation.CompletenessScore : 0,
  };
  if (typeof pronunciation.ProsodyScore === "number") scores.prosody = pronunciation.ProsodyScore;
  return scores;
}

function mapHeard(nbest: unknown): string[] {
  if (!Array.isArray(nbest)) return [];
  return nbest
    .filter(record)
    .map(entry => entry.Phoneme)
    .filter((phoneme): phoneme is string => typeof phoneme === "string");
}

function mapPhonemes(words: unknown): PhonemeAssessment[] {
  if (!Array.isArray(words)) return [];
  const phonemes: PhonemeAssessment[] = [];
  for (const word of words) {
    if (!record(word) || !Array.isArray(word.Phonemes)) continue;
    for (const phoneme of word.Phonemes) {
      if (!record(phoneme) || typeof phoneme.Phoneme !== "string") continue;
      const assessment = phoneme.PronunciationAssessment;
      phonemes.push({
        phoneme: phoneme.Phoneme,
        score: readScore(assessment) ?? 0,
        heard: mapHeard(phoneme.NBestPhonemes),
      });
    }
  }
  return phonemes;
}

function mapSyllables(words: unknown): SyllableAssessment[] {
  if (!Array.isArray(words)) return [];
  const syllables: SyllableAssessment[] = [];
  for (const word of words) {
    if (!record(word) || !Array.isArray(word.Syllables)) continue;
    for (const syllable of word.Syllables) {
      if (!record(syllable)) continue;
      const label = typeof syllable.Syllable === "string" ? syllable.Syllable : "";
      const pinyin = typeof syllable.Pinyin === "string" ? syllable.Pinyin : label;
      syllables.push({
        syllable: label,
        pinyin,
        score: readScore(syllable.PronunciationAssessment) ?? 0,
      });
    }
  }
  return syllables;
}

function mapWords(words: unknown): WordAssessment[] {
  if (!Array.isArray(words)) return [];
  return words
    .filter(record)
    .map(word => ({
      word: typeof word.Word === "string" ? word.Word : "",
      score: readScore(word.PronunciationAssessment) ?? 0,
    }));
}

export function mapAzurePronunciationResponse(body: unknown, locale: CoachLocale): AssessmentOk {
  if (!record(body) || !Array.isArray(body.NBest) || !record(body.NBest[0])) {
    throw new Error("Azure returned an unexpected pronunciation payload.");
  }
  const best = body.NBest[0];
  const pronunciation = record(best.PronunciationAssessment) ? best.PronunciationAssessment : {};
  const words = mapWords(best.Words);
  const base: AssessmentOk = {
    status: "ok",
    words,
    scores: mapScores(pronunciation),
  };
  if (locale === "en-US") base.phonemes = mapPhonemes(best.Words);
  else base.syllables = mapSyllables(best.Words);
  return base;
}