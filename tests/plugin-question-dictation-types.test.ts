/** Type-level contract for dictation delivery to plugin question editors.
 *  `npm run typecheck` is the assertion: every `@ts-expect-error` must fire. */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { DictatedSpeech } from "../src/core/dictation.ts";
import type { PluginQuestionEditorHandle } from "../src/core/plugin-questions.ts";

const base: PluginQuestionEditorHandle = { update() {}, focus() {}, dispose() {}, appendTranscript(text) { void text.length; } };

it("opted-in editors receive the {text, words} envelope through appendDictatedSpeech, never appendTranscript", async () => {
	const received: DictatedSpeech[] = [];
	const handle: PluginQuestionEditorHandle = {
		...base,
		wantsDictatedWords: true,
		appendDictatedSpeech(speech) {
			// @ts-expect-error The envelope is readonly.
			speech.text = "";
			received.push(speech);
		},
	};
	await handle.appendDictatedSpeech?.({ text: "uh yes", words: [{ word: "uh", start: 0, end: 0.2, confidence: 0.9 }] });
	assert.equal(received.length, 1);
});

/** Type-only misuse; never called, so the typechecker is the only runner. */
export function misuse(handle: PluginQuestionEditorHandle) {
	// @ts-expect-error appendDictatedSpeech takes the envelope, not a string.
	void handle.appendDictatedSpeech?.("plain transcript");
	// @ts-expect-error appendTranscript stays text-only for every editor.
	void handle.appendTranscript?.({ text: "", words: [] });
}
