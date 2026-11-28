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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Azure's REST endpoint reports the score flat on the entry; the SDK nests it under PronunciationAssessment. */
function readScore(value: unknown): number | undefined {
  if (!record(value)) return undefined;
  const direct = readNumber(value.AccuracyScore);
  if (direct !== undefined) return direct;
  const nested = value.PronunciationAssessment;
  return record(nested) ? readNumber(nested.AccuracyScore) : undefined;
}

function mapScores(entry: Record<string, unknown>): AssessmentScores {
  const source = record(entry.PronunciationAssessment) ? entry.PronunciationAssessment : entry;
  const scores: AssessmentScores = {
    accuracy: readNumber(source.AccuracyScore) ?? 0,
    fluency: readNumber(source.FluencyScore) ?? 0,
    completeness: readNumber(source.CompletenessScore) ?? 0,
  };
  const prosody = readNumber(source.ProsodyScore);
  if (prosody !== undefined) scores.prosody = prosody;
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
      phonemes.push({
        phoneme: phoneme.Phoneme,
        score: readScore(phoneme) ?? 0,
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
        score: readScore(syllable) ?? 0,
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
      score: readScore(word) ?? 0,
    }));
}

export function mapAzurePronunciationResponse(body: unknown, locale: CoachLocale): AssessmentOk {
  if (!record(body)) throw new Error("Azure returned an unexpected pronunciation payload.");
  const status = body.RecognitionStatus;
  if (typeof status === "string" && status !== "Success") {
    throw new Error(`Azure recognition status was ${status}.`);
  }
  if (!Array.isArray(body.NBest) || !record(body.NBest[0])) {
    throw new Error("Azure returned an unexpected pronunciation payload.");
  }
  const best = body.NBest[0];
  const words = mapWords(best.Words);
  const base: AssessmentOk = {
    status: "ok",
    words,
    scores: mapScores(best),
  };
  if (locale === "en-US") base.phonemes = mapPhonemes(best.Words);
  else base.syllables = mapSyllables(best.Words);
  return base;
}