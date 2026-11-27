import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDeliveryMetrics, FILLER_WORDS, formatPause, formatRate } from "../src/delivery.ts";
import type { DictatedWordLike } from "../src/delivery.ts";

/** Recorded Deepgram word shape: the plain `word` field carries no
 *  punctuation or case, exactly as the streaming reference documents. */
const DICTATED: DictatedWordLike[] = [
	{ word: "uh", start: 0.1, end: 0.3 },
	{ word: "an", start: 0.4, end: 0.6 },
	{ word: "even", start: 0.7, end: 1.2 },
	{ word: "number", start: 1.3, end: 1.9 },
	{ word: "um", start: 4.4, end: 4.6 },
	{ word: "is", start: 4.7, end: 4.9 },
	{ word: "even", start: 5.0, end: 5.4 },
];
const THRESHOLD = 2.0;

test("the fixed fixture yields exact rates and pauses", () => {
	const metrics = computeDeliveryMetrics(DICTATED, THRESHOLD);
	assert.equal(metrics.fillersPerMin, 2 / ((5.4 - 0.1) / 60));
	assert.equal(metrics.wordsPerMin, 7 / ((5.4 - 0.1) / 60));
	assert.deepEqual(metrics.pauses, [{ afterWord: "number", seconds: 4.4 - 1.9 }]);
});

test("pauses at exactly the threshold are included; smaller gaps are not", () => {
	const words: DictatedWordLike[] = [
		{ word: "first", start: 0.0, end: 1.0 },
		{ word: "exact", start: 3.0, end: 4.0 },
		{ word: "short", start: 4.5, end: 5.0 },
	];
	const metrics = computeDeliveryMetrics(words, THRESHOLD);
	assert.deepEqual(metrics.pauses, [{ afterWord: "first", seconds: 2.0 }]);
});

test("every documented filler spelling counts, case-insensitively, on the plain word field", () => {
	const words: DictatedWordLike[] = FILLER_WORDS.map((filler, index) => ({
		word: index === 0 ? filler.toUpperCase() : filler,
		start: index * 10,
		end: index * 10 + 1,
	}));
	const spanMinutes = (words[words.length - 1]!.end - words[0]!.start) / 60;
	assert.equal(computeDeliveryMetrics(words, THRESHOLD).fillersPerMin, FILLER_WORDS.length / spanMinutes);
	const punctuated: DictatedWordLike[] = [{ word: "uh.", start: 0, end: 1 }, { word: "um,", start: 2, end: 3 }];
	assert.equal(computeDeliveryMetrics(punctuated, THRESHOLD).fillersPerMin, 0, "punctuated spellings are not fillers");
});

test("a single word keeps its measurable span (word start to word end)", () => {
	const metrics = computeDeliveryMetrics([{ word: "yes", start: 2.0, end: 2.5 }], THRESHOLD);
	assert.equal(metrics.wordsPerMin, 1 / (0.5 / 60));
	assert.equal(metrics.fillersPerMin, 0);
	assert.deepEqual(metrics.pauses, []);
});

test("an empty dictation yields zero rates and no pauses", () => {
	assert.deepEqual(computeDeliveryMetrics([], THRESHOLD), { fillersPerMin: 0, wordsPerMin: 0, pauses: [] });
});

test("pauses keep word order and never look before the first or after the last word", () => {
	const words: DictatedWordLike[] = [
		{ word: "a", start: 0.0, end: 0.5 },
		{ word: "b", start: 3.0, end: 3.5 },
		{ word: "c", start: 9.0, end: 9.5 },
	];
	const metrics = computeDeliveryMetrics(words, 2.0);
	assert.deepEqual(metrics.pauses, [
		{ afterWord: "a", seconds: 2.5 },
		{ afterWord: "b", seconds: 5.5 },
	]);
});

test("rate formatting is stable and one-decimal", () => {
	assert.equal(formatRate(0), "0/min");
	assert.equal(formatRate(11.11111), "11.1/min");
	assert.equal(formatPause({ afterWord: "number", seconds: 2.5 }), `2.5s after "number"`);
});
