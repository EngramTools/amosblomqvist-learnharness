/** Runtime contract of the editor lease for opt-in dictation delivery. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { createQuestionEditorLease } from "../components/plugin-question-editor.ts";
import type { DictatedSpeech } from "../src/core/dictation.ts";
import type { PluginQuestionEditorHandle, PluginQuestionEditorProps } from "../src/core/plugin-questions.ts";

const props: PluginQuestionEditorProps = { input: { question: "Q", payload: null }, chatId: "chat", questionId: "q1", contractVersion: 1, variant: "probe", signal: new AbortController().signal, answer: { status: "empty" }, active: true, onChange() {} };
const speech = { text: "uh yes", words: [{ word: "uh", start: 0, end: 0.2, confidence: 0.9 }, { word: "yes", start: 0.3, end: 0.6, confidence: 0.95 }] };

/** A lease with `extra` handle members adopted; `failed` defaults to a test failure. */
function adoptedLease(extra: Partial<PluginQuestionEditorHandle>, failed: () => void = () => assert.fail("unexpected failure")) {
	const lease = createQuestionEditorLease({ props, publish() {}, changed() {}, failed });
	lease.adopt({ update() {}, focus() {}, dispose() {}, ...extra });
	return lease;
}

it("routes {text, words} only to a handle that sets the flag and implements appendDictatedSpeech", async () => {
	const cases: Array<[string, boolean, boolean]> = [
		["flag and callback", true, true], ["flag only", true, false], ["callback only", false, true], ["flag off", false, true],
	];
	for (const [name, flag, callback] of cases) {
		const received: unknown[] = [];
		const lease = adoptedLease({
			...(name === "flag off" ? { wantsDictatedWords: false } : flag ? { wantsDictatedWords: true } : {}),
			...(callback ? { appendDictatedSpeech: async (value: unknown) => { received.push(value); } } : {}),
		} as Partial<PluginQuestionEditorHandle>);
		await lease.appendSpeech(speech);
		const opted = flag && callback;
		assert.equal(lease.wantsWords, opted, name);
		assert.deepEqual(received, opted ? [speech] : [], name);
	}
});

it("latched speech survives a mid-run flag removal and falls back to text", async () => {
	const received: DictatedSpeech[] = [];
	const appended: string[] = [];
	const handle: PluginQuestionEditorHandle & { wantsDictatedWords: boolean } = {
		update() {}, focus() {}, dispose() {}, wantsDictatedWords: true,
		appendTranscript(text) { appended.push(text); },
		appendDictatedSpeech(speech) { received.push(speech); },
	};
	const lease = createQuestionEditorLease({ props, publish() {}, changed() {}, failed: () => assert.fail("unexpected failure") });
	lease.adopt(handle);
	await lease.appendSpeech(speech);
	handle.wantsDictatedWords = false;
	await lease.appendSpeech(speech);
	assert.deepEqual(received, [speech], "a current opt-out keeps strict appendSpeech");
	await lease.appendLatchedSpeech(speech);
	assert.deepEqual(received, [speech, speech], "a latched run still reaches the opted-in callback");
	assert.equal(appended.length, 0);

	const callbackless = createQuestionEditorLease({ props, publish() {}, changed() {}, failed: () => assert.fail("unexpected failure") });
	callbackless.adopt({ update() {}, focus() {}, dispose() {}, appendTranscript(text: string) { appended.push(text); } });
	await callbackless.appendLatchedSpeech(speech);
	assert.deepEqual(appended, [speech.text], "a vanished speech callback falls back to plain text");
});

it("an opted-in editor is a speech target without appendTranscript, and a non-function callback fails adoption", () => {
	assert.equal(adoptedLease({ wantsDictatedWords: true, appendDictatedSpeech: async () => {} }).speech, true);
	let failures = 0;
	adoptedLease({ appendDictatedSpeech: "no" as never }, () => { failures++; });
	assert.equal(failures, 1);
});
