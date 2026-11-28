/** Dictation per-word-timing seam, exercised through the real component
 *  path: recorded `Results` fixtures go through the actual WebSocket message
 *  listener, the flush, and the destination the dock routes them to. The
 *  fixture reuses the exact harness of tests/plugin-question-components
 *  (socket, audio graph, settings, React act loop) so the assertions cover
 *  the URL actually opened and what each target receives.
 */
import React, { act, useRef, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { PluginQuestionDockContent } from "../components/plugin-question-dock.tsx";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { type DictatedSpeech } from "../src/core/dictation.ts";
import type { PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginQuestionRenderer, PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";
import type { QuestionRendererRegistration } from "../components/plugin-manager.ts";
import type { PluginQuestionDraft } from "../components/session-core.ts";

/** The shared language store caches its GET for the whole process. Tests
 *  reset it by rendering a throwaway component that calls `load(true)`
 *  (hook-safe) inside React, forcing the next getLanguage() through this
 *  fixture's endpoint. */
function resetDictationLanguageForTests(): void {
	function Resetter() {
		useDictationLanguage().load(true);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	act(() => { root.render(<Resetter />); });
	act(() => { root.unmount(); });
}

class Socket extends EventTarget {
	static CONNECTING = 0; static OPEN = 1; static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	constructor() { super(); Socket.all.push(this); }
	send() {} close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
	/** Feed one recorded Deepgram `Results` message through the real listener. */
	results(payload: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(payload) })); }
	end() { this.close(); this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
}
// The component reads the URL from the constructor's second argument.
const openedUrls: string[] = [];
class RecordingSocket extends Socket {
	constructor(_url: string, protocols?: string[]) { super(); openedUrls.push(_url); void protocols; }
}
class AudioGraph { state = "running"; destination = {}; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } }
class Worklet { port = {}; connect() {} disconnect() {} }
let cleanup: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await cleanup?.(); restore?.(); cleanup = undefined; restore = undefined; Socket.all = []; openedUrls.length = 0; });

/** One recorded word plus the Deepgram-only fields the public shape drops. */
type RecordedWord = DictatedSpeech["words"][number] & { punctuated_word?: string };

/** Recorded Deepgram `Results` finals (shape per developers.deepgram.com
 *  streaming reference): one silence/empty final, two word-bearing finals. */
interface RecordedResult {
	type: string;
	is_final: boolean;
	channel: { alternatives: Array<{ transcript: string; words?: RecordedWord[] }> };
}

const RECORDED_RESULTS: RecordedResult[] = [
	{ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "", words: [] }] } },
	{
		type: "Results", is_final: true,
		channel: { alternatives: [{ transcript: "uh let me think", words: [
			{ word: "uh", start: 0.1, end: 0.3, confidence: 0.92, punctuated_word: "Uh" },
			{ word: "let", start: 0.4, end: 0.6, confidence: 0.97, punctuated_word: "let" },
			{ word: "me", start: 0.62, end: 0.8, confidence: 0.95, punctuated_word: "me" },
			{ word: "think", start: 0.9, end: 1.4, confidence: 0.93, punctuated_word: "think" },
		] }] },
	},
	{
		type: "Results", is_final: true,
		channel: { alternatives: [{ transcript: "the premise fails", words: [
			{ word: "the", start: 2.0, end: 2.2, confidence: 0.99, punctuated_word: "The" },
			{ word: "premise", start: 2.3, end: 2.9, confidence: 0.9, punctuated_word: "premise" },
			{ word: "fails", start: 3.0, end: 3.5, confidence: 0.88, punctuated_word: "fails" },
		] }] },
	},
];

const saved: PluginQuestionSnapshot = { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" }, input: { question: "Public question", payload: { reference: "PRIVATE_REFERENCE" } }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };

/** What the editor handle received: text from appendTranscript, an envelope from appendDictatedSpeech. */
type DictationDelivery = string | DictatedSpeech;

/** What fixture() hands back to its tests. */
interface SpeechFixture {
	state: { snapshot: PluginQuestionSnapshot; expanded: boolean; reveal: boolean; ready: boolean; reconciliation: "ready"; available: boolean; speech: DictationDelivery[]; fallback: string[] };
	dictation: Dictation;
	/** The fixture's shared draft — the thinking channel the dock writes. */
	draft: PluginQuestionDraft;
	/** The editor handle's live opt-in flag; flip it between renders. */
	flags: { wantsWords: boolean };
	/** Force the dock to render again (what a plugin's own state change does). */
	render(): Promise<void>;
	/** The socket of the latest dictation run. */
	socket(): RecordingSocket;
}

async function fixture(options: { thinking?: boolean; wantsWords?: boolean; omitSpeechCallback?: boolean; omitFlag?: boolean; language?: string } = {}): Promise<SpeechFixture> {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { get: () => active });
	dom.window.HTMLElement.prototype.focus = function () { active = this; };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, WebSocket: RecordingSocket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		fetch: async (url: string) => { if (url === "/api/stt/token") return Response.json({ token: "fake" }); assert.equal(url, "/api/settings"); return Response.json({ settings: { version: 1, dictation: { language: options.language ?? "en" } } }); },
	})) { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
	restore = () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; };
	(globalThis as { React: unknown }).React = React;
	// The shared language store caches its GET for the process: force a
	// fresh read so each test exercises its own fixture language.
	// useDictationLanguage is a hook — but only its body calls hooks; the
	// returned store methods are safe outside React. To stay honest, read
	// the store through a component-free path instead:
	// (see resetDictationLanguageForTests below).
	resetDictationLanguageForTests();
	const draft: PluginQuestionDraft = { answer: { status: "empty" }, thinking: "", readingThinking: "" };
	const state = { snapshot: { ...saved, showThinking: options.thinking ?? false }, expanded: true, reveal: false, ready: true, reconciliation: "ready" as const, available: true, speech: [] as DictationDelivery[], fallback: [] as string[] };
	const flags = { wantsWords: !!(options.wantsWords && !options.omitFlag) };
	let registration: QuestionRendererRegistration | undefined = { pluginId: "fixture", renderer: { id: "code", supportedContractVersions: [1], mountAnswerEditor(container, props) {
		const textarea = container.ownerDocument.createElement("textarea"); container.append(textarea);
		props.onChange({ status: "ready", value: "  code\n" });
		const handle: PluginQuestionEditorHandle = { update() {}, focus() { textarea.focus(); }, dispose() {},
			appendTranscript(text: string) { assert.equal(typeof text, "string", "appendTranscript is text-only"); state.speech.push(text); },
			get wantsDictatedWords() { return flags.wantsWords; },
			...(options.wantsWords && !options.omitSpeechCallback ? { appendDictatedSpeech(speech: DictatedSpeech) { state.speech.push(speech); } } : {}) };
		return handle;
	} } };
	let dictation!: Dictation;
	let rerender!: () => void;
	function Harness() {
		const reading = useRef<HTMLDivElement>(null);
		const [mic, setMic] = useState(false);
		const [, forceRender] = useState(0);
		rerender = () => forceRender(count => count + 1);
		dictation = useDictation({ append: text => { state.fallback.push(text); }, disabled: !mic });
		return <PluginQuestionDockContent snapshot={state.snapshot} chatId="chat" draft={draft} expanded={state.expanded} reveal={state.reveal} ready={state.ready} reconciliation={state.reconciliation} available={state.available} registration={registration} readingRef={reading} onMicAvailable={setMic}
			onExpand={() => {}} send={async input => { state.speech.push(input as unknown as string); return true; }} dismiss={async () => {}} />;
	}
	const root = createRoot(dom.document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	cleanup = async () => { await act(async () => { root.unmount(); }); };
	const f: SpeechFixture = {
		state, dictation, draft, flags,
		render: async () => { await act(async () => { rerender(); }); },
		socket: () => Socket.all.at(-1) as RecordingSocket,
	};
	return f;
}

/** Feed every recorded final through the latest run's socket, then close. */
async function dictate(f: SpeechFixture) {
	await act(async () => { f.dictation.toggle(); });
	const socket = f.socket();
	await act(async () => { socket.open(); for (const payload of RECORDED_RESULTS) socket.results(payload); });
	await act(async () => { socket.end(); });
}

const recordedWords: DictatedSpeech["words"] = RECORDED_RESULTS.slice(1).flatMap(result =>
	(result.channel.alternatives[0]!.words ?? []).map(({ word, start, end, confidence }) => ({ word, start, end, confidence })),
);

/** The last dictation run opened exactly this URL (byte-pinned). */
function assertUrl(expected: string, message?: string) {
	assert.deepEqual(openedUrls, [expected], message ?? "the socket opened with exactly one URL");
}

/** The single speech delivery, asserted to be a words envelope. */
function speechEnvelope(f: SpeechFixture): DictatedSpeech {
	const delivery = f.state.speech[0];
	if (typeof delivery !== "object" || delivery === null) throw new Error(`expected a {text, words} envelope, got ${JSON.stringify(delivery)}`);
	return delivery;
}

test("default run keeps the tuned URL and delivers plain text to the plugin editor", async () => {
	const f = await fixture({});
	await dictate(f);
	assertUrl("wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&punctuate=true&endpointing=300&language=en");
	assert.deepEqual(f.state.speech, ["uh let me think the premise fails"], "text is unchanged, never a {text, words} envelope");
	assert.deepEqual(f.state.fallback, []);
});

test("opted-in editor gets {text, words} with every final's words in order", async () => {
	const f = await fixture({ wantsWords: true });
	await dictate(f);
	const speech = speechEnvelope(f);
	assert.equal(speech.text, "uh let me think the premise fails");
	assert.equal(speech.words.length, recordedWords.length, "count matches the words Deepgram returned");
	assert.deepEqual(speech.words, recordedWords);
	for (const word of speech.words) assert.deepEqual(Object.keys(word).sort(), ["confidence", "end", "start", "word"], "only the declared fields escape");
	assert.deepEqual(f.state.fallback, []);
});

test("opted-in editor with a multilingual run gets timings without filler_words", async () => {
	const f = await fixture({ wantsWords: true, language: "multi" });
	await dictate(f);
	const speech = speechEnvelope(f);
	assert.equal(speech.language, "multi");
	assert.equal(speech.words.length, recordedWords.length, "word timings arrive in every language");
	assert.equal(speech.text, "uh let me think the premise fails");
	assert.equal(new URL(openedUrls[0]!).searchParams.has("filler_words"), false, "multilingual mode is not English");
});

test("a mid-run wantsDictatedWords flip latches the opt-in and never drops the final", async () => {
	const f = await fixture({ wantsWords: true });
	await act(async () => { f.dictation.toggle(); });
	const socket = f.socket();
	await act(async () => { socket.open(); socket.results(RECORDED_RESULTS[1]); });
	f.flags.wantsWords = false;
	await f.render();
	await act(async () => { socket.results(RECORDED_RESULTS[2]); socket.end(); });
	assert.equal(f.dictation.phase, "idle", "the flip must not cancel the live run");
	assert.deepEqual(f.state.speech, [{ text: "uh let me think the premise fails", words: recordedWords, language: "en" }], "the latched opt-in still delivers the final transcript");
	assert.deepEqual(f.state.fallback, [], "the question target still owns the text");
});

test("opted-in editor with a non-English language gets timings without filler_words", async () => {
	const f = await fixture({ wantsWords: true, language: "pl" });
	await dictate(f);
	const speech = speechEnvelope(f);
	assert.equal(speech.words.length, recordedWords.length);
	assert.equal(speech.text, "uh let me think the premise fails");
	assert.equal(openedUrls[0]!.includes("filler_words"), false, "fillers are never requested outside English");
	assert.match(openedUrls[0]!, /language=pl/);
});

/** Host thinking owns the question target while showThinking is on (the
 *  dock's `append` writes the thinking draft): text-only, and no fillers
 *  even though the editor opted in. */
test("host thinking receives text only even when an editor opts in", async () => {
	const f = await fixture({ thinking: true, wantsWords: true });
	await dictate(f);
	assert.deepEqual(f.state.speech, [], "the plugin editor is not the destination while thinking owns speech");
	assert.equal(f.draft.thinking, "uh let me think the premise fails", "thinking draft receives plain text");
	assert.deepEqual(f.state.fallback, []);
	assert.equal(new URL(openedUrls[0]!).searchParams.has("filler_words"), false, "thinking never requests fillers");
});

test("an editor that sets wantsDictatedWords without appendDictatedSpeech keeps plain text and no filler_words", async () => {
	const f = await fixture({ wantsWords: true, omitSpeechCallback: true });
	await dictate(f);
	assert.deepEqual(f.state.speech, ["uh let me think the premise fails"]);
	assert.equal(openedUrls[0]!.includes("filler_words"), false);
});

test("an editor that implements appendDictatedSpeech without the flag keeps plain text", async () => {
	const f = await fixture({ wantsWords: true, omitFlag: true });
	await dictate(f);
	assert.deepEqual(f.state.speech, ["uh let me think the premise fails"]);
	assert.equal(openedUrls[0]!.includes("filler_words"), false);
});
