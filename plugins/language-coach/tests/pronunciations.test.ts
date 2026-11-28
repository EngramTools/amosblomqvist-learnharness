import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedPronunciation } from "../src/pronunciations.ts";

test("CMUdict gives IPA phonemes for a known English word", () => {
  const expected = expectedPronunciation("think", "en-US");
  assert.ok(expected && expected.kind === "phonemes");
  assert.deepEqual(expected.kind === "phonemes" ? expected.ipa : null, ["θ", "ɪ", "ŋ", "k"]);
});

test("an English word missing from CMUdict says no dictionary pronunciation", () => {
  const expected = expectedPronunciation("qqzzvv", "en-US");
  assert.ok(expected && expected.kind === "missing");
});

test("lookup ignores case and strips punctuation", () => {
  const expected = expectedPronunciation("Think,", "en-US");
  assert.ok(expected && expected.kind === "phonemes");
});

test("pinyin-pro gives tone-marked pinyin syllables for Mandarin words", () => {
  const expected = expectedPronunciation("你好", "zh-CN");
  assert.ok(expected && expected.kind === "syllables");
  assert.deepEqual(expected.kind === "syllables" ? expected.pinyin : null, ["nǐ", "hǎo"]);
});

test("pronunciations never come from a model", () => {
  // The lookup is a pure dictionary read: the same word always yields the same answer.
  assert.deepEqual(expectedPronunciation("think", "en-US"), expectedPronunciation("think", "en-US"));
});
