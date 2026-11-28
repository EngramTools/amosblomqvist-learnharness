import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { JsonValue, PluginFrontendContext, PluginQuestionMountContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import type { ReadAloudAnswer, ReadAloudPayload, ReadAloudResult } from "../src/read-aloud-contract.ts";

type Renderer = PluginQuestionRenderer<ReadAloudPayload, ReadAloudAnswer>;

/** The exact result the backend grading test saved for "think" with θ heard as s. */
const GRADED_THINK: ReadAloudResult = {
  status: "ok",
  words: [{
    word: "think",
    score: 55,
    phonemes: [
      { phoneme: "θ", score: 20, heard: "s" },
      { phoneme: "ɪ", score: 90, heard: "ɪ" },
      { phoneme: "ŋ", score: 90, heard: "ŋ" },
      { phoneme: "k", score: 90, heard: "k" },
    ],
  }],
};

function fixture() {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  let renderer: Renderer | undefined;
  const cleanup = activate({
    ui: { mountMarkdown() { return { update() {}, dispose() {} }; } },
    call: async () => ({ configured: false, region: "", targetLanguage: "en-US", firstLanguage: "en" }),
    onNotification() {
      return () => {};
    },
    registerQuestionRenderer(value: Renderer) {
      renderer = value;
      return () => { renderer = undefined; };
    },
    registerSettings() {
      return () => {};
    },
  } as unknown as PluginFrontendContext);
  return { document, renderer: renderer!, cleanup };
}

function mountContext(signal: AbortSignal, payload: ReadAloudPayload): PluginQuestionMountContext<ReadAloudPayload> {
  return {
    input: { question: "Read this aloud.", type: "check", nodeId: "node-1", payload },
    chatId: "chat-1",
    questionId: "question-1",
    contractVersion: 1,
    variant: "teach",
    signal,
  };
}

test("the answered card shows the graded think row with the low θ and the heard /s/", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  const dispose = f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal, { text: "think", language: "en-US" }),
    answer: { recording: "Zml4dHVyZQ==" },
    grading: { result: GRADED_THINK as unknown as JsonValue },
  });
  const row = container.querySelector('[data-word="think"]');
  assert.ok(row, "the think row renders");
  assert.equal(row?.getAttribute("data-score"), "55");
  const sounds = row?.querySelector(".lh-coach-read-aloud__sounds");
  assert.match(sounds?.textContent ?? "", /θ 20 \(heard s\)/);
  assert.match(sounds?.textContent ?? "", /ŋ 90/);
  assert.equal(container.textContent?.includes("no dictionary pronunciation"), false);
  controller.abort();
  assert.equal(container.querySelector('[data-word="think"]') === null, true);
  if (typeof dispose === "function") dispose();
  f.cleanup();
});

test("a no-dictionary word and an unavailable grading both render readable rows", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal, { text: "qqzzvv", language: "en-US" }),
    answer: { recording: "Zml4dHVyZQ==" },
    grading: { result: { status: "ok", words: [{ word: "qqzzvv", score: 60, noDictionaryPronunciation: true }] } as unknown as JsonValue },
  });
  const row = container.querySelector('[data-word="qqzzvv"]');
  assert.match(row?.textContent ?? "", /no dictionary pronunciation/);

  const unavailable = f.document.createElement("div");
  f.document.body.append(unavailable);
  f.renderer.mountAnswered!(unavailable, {
    ...mountContext(controller.signal, { text: "think", language: "en-US" }),
    answer: { recording: "Zml4dHVyZQ==" },
    grading: { result: { status: "unavailable", reason: "Azure pronunciation assessment could not be reached." } as unknown as JsonValue },
  });
  assert.match(unavailable.textContent ?? "", /Your recording was saved/);
  assert.match(unavailable.textContent ?? "", /Azure pronunciation assessment could not be reached\./);
  assert.equal(unavailable.querySelector('[data-score]') === null, true, "an unavailable result shows no score");
  controller.abort();
  f.cleanup();
});

test("Mandarin results show tone-marked pinyin per syllable", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal, { text: "你好", language: "zh-CN" }),
    answer: { recording: "Zml4dHVyZQ==" },
    grading: { result: { status: "ok", words: [{ word: "你好", score: 70, syllables: [{ syllable: "1", pinyin: "nǐ", score: 85 }, { syllable: "2", pinyin: "hǎo", score: 60 }] }] } as unknown as JsonValue },
  });
  const row = container.querySelector('[data-word="你好"]');
  assert.match(row?.textContent ?? "", /nǐ 85 · hǎo 60/);
  controller.abort();
  f.cleanup();
});
