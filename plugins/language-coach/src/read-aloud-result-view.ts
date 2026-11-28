import type { PluginQuestionGradingOutcome } from "learnharness-plugin-api";
import type { ReadAloudResult, WordScore } from "./read-aloud-contract.ts";

/** The answered card: one row per word, with per-sound (en-US) or per-syllable (zh-CN) detail. */

function section(document: Document, className: string, heading: string): HTMLElement {
  const element = document.createElement("section");
  element.className = `lh-coach-read-aloud__section ${className}`;
  const label = document.createElement("div");
  label.className = "lh-coach-read-aloud__label";
  label.textContent = heading;
  element.append(label);
  return element;
}

function paragraph(document: Document, className: string, text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function mountUnavailable(document: Document, container: HTMLElement, reason: string): void {
  const unavailable = section(document, "lh-coach-read-aloud__unavailable", "Pronunciation unavailable");
  unavailable.setAttribute("role", "status");
  unavailable.append(paragraph(document, "lh-coach-read-aloud__prose", "Your recording was saved. The pronunciation assessment could not finish, so there is no score."));
  unavailable.append(paragraph(document, "lh-coach-read-aloud__prose", reason));
  container.append(unavailable);
}

/** One detail chip per sound: IPA with what was heard, or pinyin. */
function soundLabel(phoneme: { phoneme: string; score: number; heard: string }): string {
  return phoneme.heard === phoneme.phoneme
    ? `${phoneme.phoneme} ${Math.round(phoneme.score)}`
    : `${phoneme.phoneme} ${Math.round(phoneme.score)} (heard ${phoneme.heard})`;
}

function mountWord(document: Document, list: HTMLElement, word: WordScore): void {
  const item = document.createElement("li");
  item.className = "lh-coach-read-aloud__word";
  item.dataset.word = word.word;
  item.dataset.score = String(Math.round(word.score));
  const name = document.createElement("span");
  name.className = "lh-coach-read-aloud__word-name";
  name.textContent = word.word;
  const score = document.createElement("span");
  score.className = "lh-coach-read-aloud__word-score";
  score.textContent = word.noDictionaryPronunciation ? "no dictionary pronunciation" : `${Math.round(word.score)}`;
  item.append(name, score);
  const phonemes = word.phonemes ?? [];
  if (phonemes.length > 0) {
    const detail = document.createElement("span");
    detail.className = "lh-coach-read-aloud__sounds";
    detail.dataset.low = String(phonemes.some(sound => sound.score < 60));
    detail.textContent = phonemes.map(soundLabel).join(" · ");
    item.append(detail);
  }
  const syllables = word.syllables ?? [];
  if (syllables.length > 0) {
    const detail = document.createElement("span");
    detail.className = "lh-coach-read-aloud__sounds";
    detail.textContent = syllables.map(syllable => `${syllable.pinyin} ${Math.round(syllable.score)}`).join(" · ");
    item.append(detail);
  }
  list.append(item);
}

/** Render a saved read-aloud result; returns nothing, mounts into `container`. */
export function mountReadAloudResult(container: HTMLElement, grading: PluginQuestionGradingOutcome): void {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-coach-read-aloud";
  container.append(root);
  if ("error" in grading) {
    mountUnavailable(document, root, grading.error);
    return;
  }
  const result: ReadAloudResult = grading.result as ReadAloudResult;
  if (result.status !== "ok") {
    mountUnavailable(document, root, result.reason);
    return;
  }
  const words = section(document, "lh-coach-read-aloud__words", "Each word");
  const list = document.createElement("ul");
  list.className = "lh-coach-read-aloud__word-list";
  for (const word of result.words) mountWord(document, list, word);
  words.append(list);
  root.append(words);
}
