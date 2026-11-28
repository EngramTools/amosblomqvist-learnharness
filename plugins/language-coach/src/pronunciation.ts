import { dictionary } from "cmu-pronouncing-dictionary";
import { pinyin } from "pinyin-pro";
import type { CoachLocale } from "./judge-types.ts";

export type PronunciationOk = { status: "ok"; value: string; markup: string };
export type PronunciationUnavailable = { status: "unavailable"; reason: string };
export type Pronunciation = PronunciationOk | PronunciationUnavailable;

const ARPABET_TO_IPA: Record<string, string> = {
  AA: "ɑ", AE: "æ", AO: "ɔ", AW: "aʊ", AY: "aɪ", B: "b", CH: "tʃ", D: "d",
  DH: "ð", EH: "ɛ", EY: "eɪ", F: "f", G: "ɡ", HH: "h", IH: "ɪ", IY: "i",
  JH: "dʒ", K: "k", L: "l", M: "m", N: "n", NG: "ŋ", OW: "oʊ", OY: "ɔɪ",
  P: "p", R: "ɹ", S: "s", SH: "ʃ", T: "t", TH: "θ", UH: "ʊ", UW: "u",
  V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ",
};

const EN_WORD = /[A-Za-z][A-Za-z'’]*/g;
const PINYIN_TONE = /^([a-züêv]+)([0-5])$/;

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  });
}

function ipaPhone(phone: string): string | undefined {
  const match = /^([A-Z]+)([0-2])?$/.exec(phone);
  const base = match?.[1];
  if (!base) return undefined;
  const stress = match?.[2];
  if (base === "AH") return stress === "0" ? "ə" : "ʌ";
  if (base === "ER") return stress === "0" ? "ɚ" : "ɝ";
  return ARPABET_TO_IPA[base];
}

function ipaForWord(word: string): string | undefined {
  const key = word.replace(/’/g, "'").toLowerCase();
  const phones = dictionary[key] ?? dictionary[`${key}(2)`];
  if (!phones) return undefined;
  const ipa = phones.split(" ").map(ipaPhone);
  return ipa.some(phone => phone === undefined) ? undefined : ipa.join("");
}

function unavailable(reason: string): PronunciationUnavailable {
  return { status: "unavailable", reason };
}

function englishPronunciation(text: string): Pronunciation {
  let cursor = 0;
  let markup = "";
  const values: string[] = [];
  for (const match of text.matchAll(EN_WORD)) {
    const index = match.index ?? cursor;
    const word = match[0];
    const ipa = ipaForWord(word);
    if (!ipa) return unavailable(`No CMUdict pronunciation for "${word}".`);
    markup += `${escapeXml(text.slice(cursor, index))}<phoneme alphabet="ipa" ph="${escapeXml(ipa)}">${escapeXml(word)}</phoneme>`;
    values.push(ipa);
    cursor = index + word.length;
  }
  markup += escapeXml(text.slice(cursor));
  return values.length ? { status: "ok", value: values.join(" "), markup } : unavailable("The reference text has no English words.");
}

function mandarinPronunciation(text: string): Pronunciation {
  const characters = Array.from(text);
  const syllables = pinyin(text, { toneType: "num", type: "array", nonZh: "spaced", toneSandhi: false });
  let markup = "";
  const values: string[] = [];
  let runText = "";
  let runValues: string[] = [];
  const flush = () => {
    if (runValues.length) {
      markup += `<phoneme alphabet="sapi" ph="${runValues.join(" ")}">${escapeXml(runText)}</phoneme>`;
      values.push(...runValues);
    }
    runText = "";
    runValues = [];
  };
  characters.forEach((character, index) => {
    const match = PINYIN_TONE.exec(syllables[index] ?? "");
    if (!match?.[1] || !match[2]) {
      flush();
      markup += escapeXml(character);
      return;
    }
    runText += character;
    runValues.push(`${match[1]} ${match[2]}`);
  });
  flush();
  return values.length ? { status: "ok", value: values.join(" "), markup } : unavailable("The reference text has no Chinese characters.");
}

/** Dictionary pronunciation for the SSML and the cache key, never a model-supplied guess. */
export function pronunciationFor(text: string, locale: CoachLocale): Pronunciation {
  return locale === "zh-CN" ? mandarinPronunciation(text) : englishPronunciation(text);
}
