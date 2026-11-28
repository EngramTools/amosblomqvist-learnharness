import type {
  AssessmentOk,
  AssessmentResult,
  AssessmentScores,
  CoachLocale,
  PhonemeAssessment,
  SyllableAssessment,
  WordAssessment,
} from "./judge-types.ts";

const UNEXPECTED_PAYLOAD = "Azure returned an unexpected pronunciation payload.";

/** Readable reasons for the non-Success statuses the short-audio endpoint reports. */
const STATUS_REASONS = new Map<string, string>([
  ["NoMatch", "Azure could not recognise any speech in the recording."],
  ["InitialSilenceTimeout", "Azure heard only silence at the start of the recording."],
  ["BabbleTimeout", "Azure heard only background noise in the recording."],
  ["Error", "Azure could not process the recording."],
]);

/** A 200 response that lacks a score is not an assessment; it must never become a zero score. */
class PayloadError extends Error {
  constructor() {
    super(UNEXPECTED_PAYLOAD);
  }
}

type Entry = Record<string, unknown>;

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function required(value: number | undefined): number {
  if (value === undefined) throw new PayloadError();
  return value;
}

/** The SDK nests the scores under PronunciationAssessment; the REST endpoint reports them flat. */
function scoreSource(entry: Entry): Entry {
  return record(entry.PronunciationAssessment) ? entry.PronunciationAssessment : entry;
}

function readScore(entry: Entry): number {
  const nested = scoreSource(entry).AccuracyScore;
  return required(readNumber(entry.AccuracyScore) ?? readNumber(nested));
}

function mapScores(entry: Entry): AssessmentScores {
  const source = scoreSource(entry);
  const scores: AssessmentScores = {
    accuracy: required(readNumber(source.AccuracyScore)),
    fluency: required(readNumber(source.FluencyScore)),
    completeness: required(readNumber(source.CompletenessScore)),
  };
  const prosody = readNumber(source.ProsodyScore);
  if (prosody !== undefined) scores.prosody = prosody;
  return scores;
}

function records(values: unknown): Entry[] {
  return Array.isArray(values) ? values.filter(record) : [];
}

/** Every record under `key` across all words. */
function wordParts(words: unknown, key: string): Entry[] {
  return records(words).flatMap(word => records(word[key]));
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function mapHeard(nbest: unknown): string[] {
  return records(nbest).flatMap(entry => typeof entry.Phoneme === "string" ? [entry.Phoneme] : []);
}

function mapPhonemes(words: unknown): PhonemeAssessment[] {
  return records(words).flatMap(word => records(word.Phonemes)).flatMap(phoneme => typeof phoneme.Phoneme === "string"
    ? [{ phoneme: phoneme.Phoneme, score: readScore(phoneme), heard: mapHeard(phoneme.NBestPhonemes) }]
    : []);
}

function mapSyllable(syllable: Entry): SyllableAssessment {
  const label = text(syllable.Syllable);
  return { syllable: label, pinyin: text(syllable.Pinyin, label), score: readScore(syllable) };
}

function mapSyllables(words: unknown): SyllableAssessment[] {
  return records(words).flatMap(word => records(word.Syllables)).map(mapSyllable);
}

function mapWords(words: unknown): WordAssessment[] {
  return records(words).map(word => {
    const entry: WordAssessment = { word: text(word.Word), score: readScore(word) };
    const wordPhonemes = records(word.Phonemes);
    if (wordPhonemes.length > 0) {
      entry.phonemes = wordPhonemes.map(phoneme => ({
        phoneme: typeof phoneme.Phoneme === "string" ? phoneme.Phoneme : "",
        score: readScore(phoneme),
        heard: mapHeard(phoneme.NBestPhonemes),
      }));
    }
    const wordSyllables = records(word.Syllables);
    if (wordSyllables.length > 0) entry.syllables = wordSyllables.map(mapSyllable);
    return entry;
  });
}

function statusReason(body: Entry): string | undefined {
  const status = body.RecognitionStatus;
  if (typeof status !== "string" || status === "Success") return undefined;
  return STATUS_REASONS.get(status) ?? `Azure recognition status was ${status}.`;
}

function bestEntry(body: Entry): Entry {
  const best = Array.isArray(body.NBest) ? body.NBest[0] : undefined;
  if (!record(best)) throw new PayloadError();
  return best;
}

function mapBody(body: unknown, locale: CoachLocale): AssessmentResult {
  if (!record(body)) throw new PayloadError();
  const reason = statusReason(body);
  if (reason) return { status: "unavailable", reason };
  const best = bestEntry(body);
  const result: AssessmentOk = { status: "ok", words: mapWords(best.Words), scores: mapScores(best) };
  if (locale === "en-US") result.phonemes = mapPhonemes(best.Words);
  else result.syllables = mapSyllables(best.Words);
  return result;
}

/** Maps a short-audio response to an assessment, or to the reason Azure could not assess the clip. */
export function mapAzurePronunciationResponse(body: unknown, locale: CoachLocale): AssessmentResult {
  try {
    return mapBody(body, locale);
  } catch (error) {
    if (error instanceof PayloadError) return { status: "unavailable", reason: UNEXPECTED_PAYLOAD };
    throw error;
  }
}
