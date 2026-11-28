/** Speech-receiver ownership and capture-message routing. The `{text, words}`
 *  receiver belongs to the claim that registered it. A later claimant or an
 *  unmounting dock must release it, or a run starts opted in and its final
 *  reaches a dead editor. Observed through the real useDictation run (fake
 *  Deepgram socket): where the final lands and whether the URL asked for
 *  fillers. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { useDictation, useDictationTarget, usePluginQuestionDictationTarget, type Dictation } from "../components/dictation.tsx";
import type { DictatedSpeech } from "../src/core/dictation.ts";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	static urls: string[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(url: string) {
		super();
		Socket.all.push(this);
		Socket.urls.push(url);
	}
	send = (frame: unknown) => { this.sent.push(frame); };
	close = () => { this.readyState = 3; };
	emit = (type: string, extra: object = {}) => { this.dispatchEvent(Object.assign(new Event(type), extra)); };
	open = () => { this.readyState = Socket.OPEN; this.emit("open"); };
	message = (payload: unknown) => this.emit("message", { data: JSON.stringify(payload) });
	end = () => { this.readyState = 3; this.emit("close", { code: 1000 }); };
}

const NODE = { connect: () => {}, disconnect: () => {} };
class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource = () => NODE;
}
class Worklet {
	static all: Worklet[] = [];
	port: { onmessage?: (event: { data: unknown }) => void } = {};
	connect = NODE.connect;
	disconnect = NODE.disconnect;
	constructor() { Worklet.all.push(this); }
	post = (data: unknown) => this.port.onmessage?.({ data });
}

const FINAL = { type: "Results", is_final: true, channel: { alternatives: [{ transcript: "spoken words", words: [{ word: "spoken", start: 0, end: 0.4, confidence: 0.9 }, { word: "words", start: 0.5, end: 0.9, confidence: 0.9 }] }] } };

type Claimants = { dock: boolean; rival: boolean };
type Delivery = { editorText: string[]; editorSpeech: DictatedSpeech[]; plain: string[]; fallback: string[] };

let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
	await teardown?.();
	teardown = undefined;
	Socket.all = [];
	Socket.urls = [];
	Worklet.all = [];
});

/** Browser globals the dictation engine reads; returns the undo. */
function installBrowser(dom: ReturnType<typeof parseHTML>): () => void {
	const stream = { getTracks: () => [{ stop: () => {} }] };
	const settings = { settings: { version: 1, dictation: { language: "en" } } };
	const globals = {
		React, window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => stream } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		fetch: async (url: string) => Response.json(url === "/api/stt/token" ? { token: "fake" } : settings),
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
}

/** The page: one useDictation owner plus whichever claimants are mounted. */
function createPage(got: Delivery) {
	const holder: { dictation?: Dictation } = {};
	const editorText = (text: string) => { got.editorText.push(text); };
	const editorSpeech = (speech: DictatedSpeech) => { got.editorSpeech.push(speech); };
	const plain = (text: string) => { got.plain.push(text); };
	const Dock = () => { usePluginQuestionDictationTarget(editorText, true, editorSpeech); return null; };
	const Rival = () => { useDictationTarget(plain, true); return null; };
	const Page = ({ dock, rival }: Claimants) => {
		holder.dictation = useDictation({ append: text => { got.fallback.push(text); } });
		return <>{dock && <Dock />}{rival && <Rival />}</>;
	};
	return { holder, Page };
}

async function fixture(initial: Claimants) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const restore = installBrowser(dom);
	const root = createRoot(dom.document.getElementById("root")!);
	const got: Delivery = { editorText: [], editorSpeech: [], plain: [], fallback: [] };
	const { holder, Page } = createPage(got);
	teardown = async () => {
		await act(async () => { root.unmount(); });
		restore();
	};
	const render = async (props: Claimants) => { await act(async () => { root.render(<Page {...props} />); }); };
	await render(initial);
	/** Start a run and leave it connecting (socket not yet open). */
	const start = async () => {
		await act(async () => { holder.dictation!.toggle(); });
		return { socket: Socket.all.at(-1)!, worklet: Worklet.all.at(-1)! };
	};
	/** One full run: start, one final, server close. Returns the opened URL. */
	const dictate = async () => {
		const { socket } = await start();
		await act(async () => { socket.open(); socket.message(FINAL); });
		await act(async () => { socket.end(); });
		return new URL(Socket.urls.at(-1)!);
	};
	return { got, render, start, dictate, dictation: () => holder.dictation! };
}

test("a later plain claimant takes dictation and releases the earlier editor's speech receiver", async () => {
	const f = await fixture({ dock: true, rival: false });
	const optedIn = await f.dictate();
	assert.equal(f.got.editorSpeech.length, 1, "control: the claiming editor receives its {text, words} final");
	assert.equal(f.got.editorSpeech[0]!.text, "spoken words");
	assert.equal(optedIn.searchParams.get("filler_words"), "true", "control: the opted-in run asks for fillers");

	await f.render({ dock: true, rival: true });
	const plainRun = await f.dictate();
	assert.deepEqual(f.got.plain, ["spoken words"], "the later claimant owns the text");
	assert.equal(f.got.editorSpeech.length, 1, "the older editor's speech receiver is not used for the later claimant's run");
	assert.deepEqual(f.got.editorText, []);
	assert.equal(plainRun.searchParams.has("filler_words"), false, "the later claimant's run is not opted in");
});

test("an unmounted dock leaves no speech receiver behind for the main fallback", async () => {
	const f = await fixture({ dock: true, rival: false });
	await f.dictate();
	assert.equal(f.got.editorSpeech.length, 1, "control: the mounted dock receives speech");

	await f.render({ dock: false, rival: false });
	const fallbackRun = await f.dictate();
	assert.deepEqual(f.got.fallback, ["spoken words"], "after unmount the main input owns the text");
	assert.equal(f.got.editorSpeech.length, 1, "the unmounted editor's speech receiver is gone");
	assert.deepEqual(f.got.editorText, []);
	assert.equal(fallbackRun.searchParams.has("filler_words"), false, "the fallback run is not opted in");
});

/** An audio message whose frame encodes `id` in two bytes (ids may exceed 255). */
const audio = (id: number) => ({ type: "audio", buffer: new Uint8Array([id % 256, id >> 8]).buffer });
const frameIds = (socket: Socket) => socket.sent.map(frame => { const [low, high] = new Uint8Array(frame as ArrayBuffer); return low! + high! * 256; });

test("audio captured before the socket opens queues at most 256 frames, oldest dropped, flushed in order", async () => {
	const f = await fixture({ dock: false, rival: false });
	const { socket, worklet } = await f.start();
	await act(async () => { for (let id = 0; id < 300; id++) worklet.post(audio(id)); });
	assert.deepEqual(socket.sent, [], "nothing is sent before the socket is open");
	await act(async () => { socket.open(); });
	assert.deepEqual(frameIds(socket), Array.from({ length: 256 }, (_, index) => 44 + index), "the oldest 44 frames were dropped and the rest keep their order");
	await act(async () => { worklet.post(audio(7)); });
	assert.equal(socket.sent.length, 257, "once open, audio is sent straight through");
});

test("capture messages from a finished run never reach the next run", async () => {
	const f = await fixture({ dock: false, rival: false });
	const first = await f.start();
	await act(async () => { first.socket.open(); first.socket.end(); });
	assert.equal(f.dictation().phase, "idle");

	const second = await f.start();
	await act(async () => { second.worklet.post({ type: "level", rms: 0.5 }); });
	assert.equal(f.dictation().levelRef.current, 0.5);
	await act(async () => {
		first.worklet.post({ type: "level", rms: 0.9 });
		first.worklet.post(audio(1));
		first.worklet.post(audio(2));
	});
	assert.equal(f.dictation().levelRef.current, 0.5, "a stale worklet cannot move the meter");
	await act(async () => { second.socket.open(); });
	assert.deepEqual(frameIds(second.socket), [], "a stale worklet cannot queue audio into the new run");
	assert.deepEqual(frameIds(first.socket), [], "and nothing was sent on the dead socket");
});
