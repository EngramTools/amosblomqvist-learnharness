import type { PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import type { CoachLocale } from "./judge-types.ts";

export const QUESTION_TYPE_ID = "read-aloud";
export const RESULT_VERSION = 1;

export type ReadAloudPayload = {
  /** The text the learner must read aloud. */
  text: string;
  /** The language to read it in: `en-US` or `zh-CN`. */
  language: CoachLocale;
};

export type ReadAloudAnswer = {
  /** The recorded clip, 16 kHz mono PCM WAV, base64-encoded. */
  recording: string;
};

/** One scored phoneme: the expected IPA sound, how well it matched, and what was heard instead. */
export type PhonemeScore = { phoneme: string; score: number; heard: string };
export type SyllableScore = { syllable: string; pinyin: string; score: number };

export type WordScore = {
  word: string;
  score: number;
  /** en-US: per-phoneme scores with the sounds actually heard. */
  phonemes?: PhonemeScore[];
  /** zh-CN: per-syllable pinyin scores. */
  syllables?: SyllableScore[];
  /** Set when the bundled dictionary has no pronunciation for this word. */
  noDictionaryPronunciation?: true;
};

export type ReadAloudResult =
  | { status: "ok"; words: WordScore[] }
  | { status: "unavailable"; reason: string };

export const readAloudInstructions = [
  "You can pose a read-aloud drill with the read_aloud tool. Use it when the learner should practice pronouncing a specific word, phrase or sentence in the target language — for example after a pronunciation mistake, or to train a difficult sound.",
  "Put the text to read in payload.text and the target language in payload.language (en-US or zh-CN). The learner records themselves reading it.",
  "The plugin supplies the expected pronunciation from its bundled dictionaries (CMUdict for English, pinyin-pro for Mandarin); you never need to provide or guess pronunciations. Each word is scored per sound (English) or per syllable (Mandarin), with the sound actually heard.",
].join(" ");

export const definition = {
  id: QUESTION_TYPE_ID,
  label: "Read-aloud drill",
  contractVersion: 1,
  showThinking: false,
  questionSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        pattern: "\\S",
        description: "The word, phrase or sentence the learner must read aloud.",
      },
      language: {
        type: "string",
        enum: ["en-US", "zh-CN"],
        description: "The language the learner reads in.",
      },
    },
    required: ["text", "language"],
    additionalProperties: false,
  },
  answerSchema: {
    type: "object",
    properties: {
      recording: {
        type: "string",
        pattern: "\\S",
        description: "The learner's recorded clip, base64-encoded 16 kHz mono PCM WAV.",
      },
    },
    required: ["recording"],
    additionalProperties: false,
  },
  teach: {
    toolName: "read_aloud",
    description: "Pose a read-aloud drill: the learner records themselves reading payload.text in payload.language (en-US or zh-CN) and sees per-sound (English) or per-syllable (Mandarin) pronunciation results. The plugin supplies expected pronunciations from bundled dictionaries.",
  },
} satisfies PluginQuestionTypeDefinition;
