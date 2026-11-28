import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";
import type { CoachLocale } from "./judge-types.ts";

/** Locate the bundled CMUdict in both source (ESM) and built (CJS) layouts. */
declare const require: NodeRequire;
function dictionaryPath(): string {
  const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "dictionaries/cmudict-arpabet.json");
}

// A plain JSON import would forbid reserved-word keys ("eval", "arguments"); read the bundled file instead.
const cmudict = JSON.parse(readFileSync(dictionaryPath(), "utf8")) as Record<string, string[]>;

/** The expected pronunciation always comes from the bundled dictionaries,
 *  never from a model: CMUdict (Arpabet) for English, pinyin-pro for Mandarin. */

export type ExpectedPronunciation =
  | { kind: "phonemes"; ipa: string[] }
  | { kind: "syllables"; pinyin: string[] }
  | { kind: "missing" };

/** Arpabet phoneme → IPA, keyed without stress digits. Stress markers are dropped;
 *  the drill reports which sounds were heard, not the dictionary's stress pattern. */
const ARPABET_TO_IPA: Record<string, string> = {
  AA: "ɑ", AE: "æ", AH: "ʌ", AO: "ɔ", AW: "aʊ", AY: "aɪ", B: "b", CH: "tʃ", D: "d",
  DH: "ð", EH: "ɛ", ER: "ɜr", EY: "eɪ", F: "f", G: "ɡ", HH: "h", IH: "ɪ", IY: "i",
  JH: "dʒ", K: "k", L: "l", M: "m", N: "n", NG: "ŋ", OW: "oʊ", OY: "ɔɪ", P: "p",
  R: "r", S: "s", SH: "ʃ", T: "t", TH: "θ", UH: "ʊ", UW: "u", V: "v", W: "w",
  Y: "j", Z: "z", ZH: "ʒ",
};

function toIpa(phonemes: string[]): string[] {
  const mapped = phonemes.map(phoneme => ARPABET_TO_IPA[phoneme.replace(/[012]$/, "")]);
  // Every Arpabet phoneme this dictionary ships must map; an unknown symbol is a data bug, not a guess.
  if (mapped.some(ipa => ipa === undefined)) throw new Error(`CMUdict contains an unmapped Arpabet phoneme: ${phonemes.join(" ")}`);
  return mapped as string[];
}

/** Reduce a learner-visible token to its dictionary key: lower-case, without punctuation. */
function dictionaryKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}'’-]/gu, "");
}

/** CMUdict keys contractions with a straight apostrophe. */
function contractionKey(key: string): string {
  return key.replace(/’/g, "'");
}

export function expectedPronunciation(word: string, locale: CoachLocale): ExpectedPronunciation {
  const key = contractionKey(dictionaryKey(word));
  if (!key) return { kind: "missing" };
  if (locale === "zh-CN") {
    const syllables = pinyin(key, { type: "array", toneType: "symbol" });
    return syllables.length > 0 ? { kind: "syllables", pinyin: syllables } : { kind: "missing" };
  }
  const phonemes = (cmudict as Record<string, string[]>)[key];
  return phonemes ? { kind: "phonemes", ipa: toIpa(phonemes) } : { kind: "missing" };
}
