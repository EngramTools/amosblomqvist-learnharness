type Entry = Record<string, unknown>;

const SCORE_LABELS = ["accuracy", "fluency", "completeness", "prosody"];

function record(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lines(values: unknown, label: (entry: Entry) => string, extra: (entry: Entry) => string = () => ""): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter(record).map(entry => `${label(entry)} — ${readNumber(entry.score) ?? 0}${extra(entry)}`);
}

function heardSuffix(entry: Entry): string {
  const heard = Array.isArray(entry.heard) ? entry.heard.filter(item => typeof item === "string") : [];
  return heard.length ? ` (heard: ${heard.join(", ")})` : "";
}

/** One readable line per scored word, phoneme or syllable. */
export function assessmentLines(result: Entry): string[] {
  return [
    ...lines(result.words, entry => readText(entry.word)),
    ...lines(result.phonemes, entry => readText(entry.phoneme), heardSuffix),
    ...lines(result.syllables, entry => readText(entry.pinyin) || readText(entry.syllable)),
  ];
}

/** "Assessment received. Accuracy 88, Fluency 90." from whichever scores are present. */
export function assessmentSummary(result: Entry): string {
  const scores = record(result.scores) ? result.scores : {};
  const parts = SCORE_LABELS.flatMap(label => {
    const score = readNumber(scores[label]);
    return score === undefined ? [] : [`${label.charAt(0).toUpperCase()}${label.slice(1)} ${score}`];
  });
  return parts.length ? `Assessment received. ${parts.join(", ")}.` : "Assessment received.";
}
