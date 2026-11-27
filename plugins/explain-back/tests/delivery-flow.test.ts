import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseHTML } from "linkedom";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ChatRecord,
	ModelCatalogResponse,
	PluginBackendContext,
	PluginInferenceRequest,
	PluginQuestionEditorHandle,
	PluginQuestionEditorProps,
	PluginQuestionGradingContext,
	PluginQuestionTypeDefinition,
} from "learnharness-plugin-api";
import { activate, type ExplainBackBackendOptions } from "../src/backend.ts";
import { DELIVERY_CRITERION, GAP_KINDS, literalReaderInstructions, readProvenance, type ExplainBackPayload } from "../src/contract.ts";
import { fixWordingInstructions } from "../src/grader.ts";
import { mountAnswerEditor } from "../src/editor.ts";
import { mountAnsweredCard } from "../src/result-view.ts";
import { sendJson, stubJsonServer } from "./support/http-stub.ts";

const API_KEY = "sk-delivery-secret";
const payload: ExplainBackPayload = {
	step: "Every even square is divisible by 4.",
	premises: ["An even number is 2k.", "Squaring 2k gives 4k²."],
};
const explanation = "uh an even number is 2k, um so its square is 4k².";
const literalResult = {
	version: 1 as const,
	reconstruction: "An even number is 2k, and its square is 4k².",
	gaps: [{ kind: "missing step" as const, detail: "Squaring 2k gives 4k²." }],
};
const criteria = {
	"missing step": 0.82,
	"undefined term": 0.11,
	"wrong order": 0.04,
	"conclusion buried": 0.27,
	[DELIVERY_CRITERION]: 0.61,
};
const wording = "Next time, drop the fillers and state the square before the conclusion.";
const temporaryDirectories: string[] = [];

after(() => {
	for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-delivery-"));
	temporaryDirectories.push(directory);
	return directory;
}

function reply(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as unknown as AssistantMessage;
}

function catalog(): ModelCatalogResponse {
	return {
		defaults: { model: { provider: "test", id: "default-model" }, thinkingLevel: "low" },
		models: [{ id: "default-model", provider: "test" }],
		rolePins: {},
		slots: {},
		providers: [],
	} as unknown as ModelCatalogResponse;
}

type Handler = (input: unknown) => unknown | Promise<unknown>;

function fixture(options: { interviewMode?: boolean; pauseThresholdSeconds?: number; noKey?: boolean; jevEndpoint?: string } = {}) {
	const dataDirectory = tempDirectory();
	const handlers = new Map<string, Handler>();
	const requests: PluginInferenceRequest[] = [];
	let definition: PluginQuestionTypeDefinition | undefined;
	const inference = {
		catalog: async () => catalog(),
		complete: async (request: PluginInferenceRequest) => {
			requests.push(request);
			const systemPrompt = request.context.systemPrompt ?? "";
			if (systemPrompt === literalReaderInstructions) return reply(JSON.stringify(literalResult));
			if (systemPrompt === fixWordingInstructions) return reply(wording);
			throw new Error("Unexpected inference request.");
		},
	};
	const cleanup = activate({
		dataDirectory,
		signal: new AbortController().signal,
		events: { emit() {} },
		handle(name: string, handler: Handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		inference,
		learning: { getSession: () => null as ChatRecord | null },
		registerQuestionType(value: typeof definition) {
			definition = value;
			return () => {};
		},
	} as unknown as PluginBackendContext, {
		jev: { endpoint: options.jevEndpoint ?? "http://127.0.0.1:9/unreachable", timeoutMs: 250 },
	} as ExplainBackBackendOptions);
	if (options.interviewMode) handlers.get("set-interview-mode")!({ mode: true });
	if (options.pauseThresholdSeconds !== undefined) handlers.get("set-pause-threshold")!({ seconds: options.pauseThresholdSeconds });
	if (!options.noKey) handlers.get("set-typesafe-key")!({ key: API_KEY });
	return { grade: definition!.gradeAnswer as unknown as (context: PluginQuestionGradingContext<ExplainBackPayload, { text: string }>) => Promise<Record<string, unknown>>, handlers, requests, dataDirectory, cleanup };
}

/** A dictated answer: unedited provenance from a Deepgram-shaped finals run. */
function dictatedAnswer(language = "en") {
	return {
		text: explanation,
		language,
		words: [
			{ word: "uh", start: 0.1, end: 0.3, confidence: 0.9 },
			{ word: "an", start: 0.4, end: 0.6, confidence: 0.97 },
			{ word: "even", start: 0.7, end: 1.2, confidence: 0.95 },
			{ word: "number", start: 1.3, end: 1.9, confidence: 0.93 },
			{ word: "um", start: 4.4, end: 4.6, confidence: 0.9 },
			{ word: "is", start: 4.7, end: 4.9, confidence: 0.97 },
			{ word: "2k", start: 5.0, end: 5.4, confidence: 0.95 },
		],
	};
}

function gradingContext(answer: unknown): PluginQuestionGradingContext<ExplainBackPayload, { text: string }> {
	return {
		chatId: "chat-delivery",
		questionId: "question-delivery",
		variant: "teach",
		contractVersion: 1,
		input: { type: "check", nodeId: "node-delivery", question: "Explain the step.", payload },
		answer: answer as { text: string },
		signal: new AbortController().signal,
	};
}

test("interview mode with dictated English computes delivery, asks Jev the fifth criterion and includes metrics in state", async () => {
	const stub = await stubJsonServer((_request, response) => sendJson(response, 200, {
		model: "jev-1.14.0",
		answers: {
			...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: criteria[kind] }])),
			[DELIVERY_CRITERION]: { type: "noul", noul: criteria[DELIVERY_CRITERION] },
			fix: { type: "choice", choice: DELIVERY_CRITERION, confidence: 0.6, probabilities: criteria },
		},
	}));
	const f = fixture({ interviewMode: true, jevEndpoint: stub.url });
	try {
		const result = await f.grade(gradingContext(dictatedAnswer()));
		const delivery = result.delivery as { status: string; fillersPerMin: number; wordsPerMin: number; pauses: { afterWord: string; seconds: number }[] };
		assert.equal(delivery.status, "ok");
		assert.equal(delivery.fillersPerMin, 2 / ((5.4 - 0.1) / 60));
		assert.equal(delivery.wordsPerMin, 7 / ((5.4 - 0.1) / 60));
		assert.deepEqual(delivery.pauses.map(pause => Math.round(pause.seconds * 1e9) / 1e9), [2.5]);
		const scoring = result.scoring as { status: string; criteria: Record<string, number> };
		assert.equal(scoring.status, "ok");
		assert.equal(scoring.criteria[DELIVERY_CRITERION], 0.61);
		assert.deepEqual(result, {
			...literalResult,
			scoring: { status: "ok", criteria, fix: { criterion: DELIVERY_CRITERION, probability: 0.61, wording } },
			delivery,
		});
		assert.equal(f.requests.length, 2);
		assert.match(String(f.requests[1]!.context.messages[0]!.content), /filler/);
		const body = stub.requests[0]!.body as { state: { metrics?: unknown } };
		assert.ok(body.state.metrics, "the Jev request state carries the delivery metrics");
	} finally {
		f.cleanup();
		await stub.close();
	}
});

test("typed answers and non-English dictation stay unavailable with the exact reasons", async () => {
	const f = fixture({ interviewMode: true });
	try {
		const typed = await f.grade(gradingContext({ text: explanation }));
		assert.deepEqual(typed.delivery, { status: "unavailable", reason: "typed answer" });
		const polish = await f.grade(gradingContext({ ...dictatedAnswer("pl"), text: "Parzysta liczba to 2k." }));
		assert.deepEqual(polish.delivery, { status: "unavailable", reason: "not available for this language" });
		const multilingual = await f.grade(gradingContext({ ...dictatedAnswer("multi"), text: explanation }));
		assert.deepEqual(multilingual.delivery, { status: "unavailable", reason: "not available for this language" });
	} finally {
		f.cleanup();
	}
});

test("an edited dictation (no provenance) is a typed answer for delivery", async () => {
	const f = fixture({ interviewMode: true });
	try {
		const result = await f.grade(gradingContext({ text: explanation }));
		assert.deepEqual(result.delivery, { status: "unavailable", reason: "typed answer" });
	} finally {
		f.cleanup();
	}
});

test("interview mode off keeps delivery unavailable even for a dictated answer", async () => {
	const f = fixture({});
	try {
		const result = await f.grade(gradingContext(dictatedAnswer()));
		assert.deepEqual(result.delivery, { status: "unavailable", reason: "Interview mode is off." });
	} finally {
		f.cleanup();
	}
});

test("out-of-range pause thresholds are rejected; in-range values persist", async () => {
	const f = fixture();
	try {
		assert.throws(() => f.handlers.get("set-pause-threshold")!({ seconds: 0.4 }), /between 0.5 and 10/i);
		assert.throws(() => f.handlers.get("set-pause-threshold")!({ seconds: 10.5 }), /between 0.5 and 10/i);
		assert.throws(() => f.handlers.get("set-pause-threshold")!({ seconds: "2" }), /between 0.5 and 10/i);
		f.handlers.get("set-pause-threshold")!({ seconds: 0.5 });
		const stored = JSON.parse(fs.readFileSync(path.join(f.dataDirectory, "settings.json"), "utf8"));
		assert.equal(stored.pauseThresholdSeconds, 0.5);
	} finally {
		f.cleanup();
	}
});

test("the pause threshold setting bounds the reported pauses", async () => {
	const stub = await stubJsonServer((_request, response) => sendJson(response, 200, {
		model: "jev-1.14.0",
		answers: {
			...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: criteria[kind] }])),
			[DELIVERY_CRITERION]: { type: "noul", noul: criteria[DELIVERY_CRITERION] },
			fix: { type: "choice", choice: DELIVERY_CRITERION, confidence: 0.6, probabilities: criteria },
		},
	}));
	const dataDirectory = tempDirectory();
	const handlers = new Map<string, Handler>();
	const requests: PluginInferenceRequest[] = [];
	let definition: PluginQuestionTypeDefinition | undefined;
	const cleanup = activate({
		dataDirectory,
		signal: new AbortController().signal,
		events: { emit() {} },
		handle(name: string, handler: Handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		inference: {
			catalog: async () => catalog(),
			complete: async (request: PluginInferenceRequest) => {
				requests.push(request);
				const systemPrompt = request.context.systemPrompt ?? "";
				if (systemPrompt === literalReaderInstructions) return reply(JSON.stringify(literalResult));
				if (systemPrompt === fixWordingInstructions) return reply(wording);
				throw new Error("Unexpected inference request.");
			},
		},
		learning: { getSession: () => null as ChatRecord | null },
		registerQuestionType(value: typeof definition) {
			definition = value;
			return () => {};
		},
	} as unknown as PluginBackendContext, { jev: { endpoint: stub.url, timeoutMs: 500 } } as ExplainBackBackendOptions);
	try {
		handlers.get("set-interview-mode")!({ mode: true });
		handlers.get("set-pause-threshold")!({ seconds: 3 });
		handlers.get("set-typesafe-key")!({ key: API_KEY });
		const grade = definition!.gradeAnswer as unknown as (context: PluginQuestionGradingContext<ExplainBackPayload, { text: string }>) => Promise<Record<string, unknown>>;
		const result = await grade(gradingContext(dictatedAnswer()));
		const delivery = result.delivery as { pauses: { afterWord: string; seconds: number }[] };
		assert.deepEqual(delivery.pauses, [], "a 2.5 s gap is below the configured 3 s threshold");
		const body = stub.requests[0]!.body as { state: { metrics?: unknown }; questions: Record<string, { type?: string }> };
		assert.ok(body.state.metrics);
		assert.deepEqual(Object.keys(body.questions).sort(), [...GAP_KINDS, DELIVERY_CRITERION, "fix"].sort());
		assert.equal(body.questions[DELIVERY_CRITERION]!.type, "noul");
	} finally {
		cleanup();
		await stub.close();
	}
});

test("the opted-in editor publishes provenance and a typed edit drops it", () => {
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const container = document.createElement("div");
	document.body.append(container);
	const states: { status: string; value?: { text: string; language?: string; words?: unknown[] } }[] = [];
	const controller = new AbortController();
	const props = {
		input: { question: "Explain the step.", type: "check", nodeId: "node-editor", payload },
		chatId: "chat-editor",
		questionId: "question-editor",
		contractVersion: 1,
		variant: "teach",
		signal: controller.signal,
		active: true,
		answer: { status: "empty" },
		onChange(state: { status: string; value?: { text: string } }) { states.push(state as (typeof states)[number]); },
	} as unknown as PluginQuestionEditorProps<ExplainBackPayload>;
	const handle = mountAnswerEditor(container, props, { interviewMode: true }) as PluginQuestionEditorHandle;
	assert.equal((handle as { wantsDictatedWords?: boolean }).wantsDictatedWords, true);

	const before = container.querySelector("textarea")!;
	assert.equal(before.value, "");
	handle.appendDictatedSpeech!({ text: "uh an even number", language: "en", words: [{ word: "uh", start: 0.1, end: 0.3, confidence: 0.9 }, { word: "an", start: 0.4, end: 0.6, confidence: 0.97 }] });
	const dictated = states.at(-1)!;
	assert.equal(dictated.status, "ready");
	assert.equal(dictated.value!.language, "en");
	assert.equal(dictated.value!.words!.length, 2);
	assert.equal(dictated.value!.text, "uh an even number");

	const input = document.createEvent("Event");
	input.initEvent("input");
	before.dispatchEvent(input);
	const edited = states.at(-1)!;
	assert.equal(edited.status, "ready");
	assert.equal(edited.value!.language, undefined);
	assert.equal(edited.value!.words, undefined);
	assert.equal(edited.value!.text, "uh an even number");

	handle.dispose();
});

test("an editor with interview mode off stays text-only", () => {
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const container = document.createElement("div");
	document.body.append(container);
	const states: { status: string }[] = [];
	const controller = new AbortController();
	const props = {
		input: { question: "Explain the step.", type: "check", nodeId: "node-editor", payload },
		chatId: "chat-editor",
		questionId: "question-editor",
		contractVersion: 1,
		variant: "teach",
		signal: controller.signal,
		active: true,
		answer: { status: "empty" },
		onChange(state: { status: string }) { states.push(state); },
	} as unknown as PluginQuestionEditorProps<ExplainBackPayload>;
	const handle = mountAnswerEditor(container, props) as PluginQuestionEditorHandle;
	assert.equal((handle as { wantsDictatedWords?: boolean }).wantsDictatedWords, undefined);
	assert.equal(typeof (handle as { appendDictatedSpeech?: unknown }).appendDictatedSpeech, "undefined");
	handle.appendTranscript!("plain text");
	assert.equal((states.at(-1) as { value?: { text: string } }).value!.text, "plain text");
	handle.dispose();
});

test("the answered card shows delivery rates and every long pause", () => {
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const container = document.createElement("div");
	document.body.append(container);
	const controller = new AbortController();
	mountAnsweredCard(container, { mountMarkdown(element, props) {
		const node = element.ownerDocument.createElement("div");
		node.textContent = props.text;
		element.append(node);
		return { update() {}, dispose() { node.remove(); } };
	} }, {
		input: { question: "Explain the step.", type: "check", nodeId: "node-view", payload },
		chatId: "chat-view",
		questionId: "question-view",
		contractVersion: 1,
		variant: "teach",
		signal: controller.signal,
		answer: { text: explanation },
		grading: {
			result: {
				version: 1,
				reconstruction: literalResult.reconstruction,
				gaps: literalResult.gaps,
				scoring: { status: "ok", criteria, fix: { criterion: DELIVERY_CRITERION, probability: 0.61, wording } },
				delivery: { status: "ok", fillersPerMin: 22.6, wordsPerMin: 79.2, pauses: [{ afterWord: "number", seconds: 2.5 }] },
			},
		},
	} as Parameters<typeof mountAnsweredCard>[2]);

	const text = container.textContent!;
	assert.match(text, /Delivery/);
	assert.match(text, /Fillers: 22\.6\/min/);
	assert.match(text, /Words: 79\.2\/min/);
	assert.match(text, /2\.5s after "number"/);
	assert.match(text, /Filler rate high/);
	const deliverySection = container.querySelector(".lh-explain-back__delivery")!;
	assert.ok(deliverySection);
	controller.abort();
	assert.equal(container.textContent, "");
});

test("the answered card hides the delivery section when delivery is unavailable", () => {
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const container = document.createElement("div");
	document.body.append(container);
	const controller = new AbortController();
	mountAnsweredCard(container, { mountMarkdown(element, props) {
		const node = element.ownerDocument.createElement("div");
		node.textContent = props.text;
		element.append(node);
		return { update() {}, dispose() { node.remove(); } };
	} }, {
		input: { question: "Explain the step.", type: "check", nodeId: "node-view", payload },
		chatId: "chat-view",
		questionId: "question-view",
		contractVersion: 1,
		variant: "teach",
		signal: controller.signal,
		answer: { text: explanation },
		grading: {
			result: {
				version: 1,
				reconstruction: literalResult.reconstruction,
				gaps: literalResult.gaps,
				scoring: { status: "ok", criteria, fix: { criterion: DELIVERY_CRITERION, probability: 0.61, wording } },
				delivery: { status: "unavailable", reason: "typed answer" },
			},
		},
	} as Parameters<typeof mountAnsweredCard>[2]);

	assert.equal(container.querySelector(".lh-explain-back__delivery"), null);
	controller.abort();
});

function editorProps(answer: unknown, states: { status: string; value?: { text: string; language?: string; words?: { start: number; end: number }[] } }[]) {
	const { document } = parseHTML("<!doctype html><html><body></body></html>");
	const container = document.createElement("div");
	document.body.append(container);
	const props = {
		input: { question: "Explain the step.", type: "check", nodeId: "node-editor", payload },
		chatId: "chat-editor",
		questionId: "question-editor",
		contractVersion: 1,
		variant: "teach",
		signal: new AbortController().signal,
		active: true,
		answer,
		onChange(state: (typeof states)[number]) { states.push(state); },
	} as unknown as PluginQuestionEditorProps<ExplainBackPayload>;
	return { container, props };
}

test("a second dictation run lands on one ordered timeline that grades", async () => {
	const states: Parameters<typeof editorProps>[1] = [];
	const { container, props } = editorProps({ status: "empty" }, states);
	const handle = mountAnswerEditor(container, props, { interviewMode: true }) as PluginQuestionEditorHandle;
	// Each run times its words from its own start, so both runs begin near zero.
	handle.appendDictatedSpeech!({ text: "uh an even number", language: "en", words: [{ word: "uh", start: 0.1, end: 0.3, confidence: 0.9 }, { word: "an", start: 0.4, end: 1.0, confidence: 0.97 }] });
	handle.appendDictatedSpeech!({ text: "is 2k", language: "en", words: [{ word: "is", start: 0.2, end: 0.4, confidence: 0.97 }, { word: "2k", start: 0.5, end: 0.9, confidence: 0.95 }] });
	const saved = states.at(-1)!;
	assert.equal(saved.status, "ready");
	assert.equal(saved.value!.text, "uh an even number is 2k");
	const words = readProvenance(saved.value)!.words;
	assert.deepEqual(words.map(word => [word.word, word.start, word.end]), [["uh", 0.1, 0.3], ["an", 0.4, 1.0], ["is", 1.2, 1.4], ["2k", 1.5, 1.9]]);
	handle.dispose();

	const f = fixture({ interviewMode: true });
	try {
		const result = await f.grade(gradingContext(saved.value));
		assert.equal((result.delivery as { status: string }).status, "ok");
		assert.equal((result.delivery as { wordsPerMin: number }).wordsPerMin, 4 / ((1.9 - 0.1) / 60));
	} finally {
		f.cleanup();
	}
});

test("a remounted or restored editor keeps the language and words of its saved dictated answer", () => {
	const states: Parameters<typeof editorProps>[1] = [];
	const answer = { status: "ready", value: dictatedAnswer() };
	const { container, props } = editorProps(answer, states);
	const handle = mountAnswerEditor(container, props, { interviewMode: true }) as PluginQuestionEditorHandle;
	assert.deepEqual(states.at(-1), answer, "the mount republishes the saved answer unchanged");
	// The host echoing the editor's own state back changes nothing.
	handle.update({ answer: states.at(-1)! as never, active: true });
	handle.appendDictatedSpeech!({ text: "so", language: "en", words: [{ word: "so", start: 0.1, end: 0.2, confidence: 0.9 }] });
	assert.equal(states.at(-1)!.value!.words!.length, 8, "a following run extends the saved timings");
	// A replaced answer brings its own provenance; a plain one carries none.
	handle.update({ answer: { status: "ready", value: { text: "Plain replacement." } }, active: true });
	handle.appendDictatedSpeech!({ text: "more", language: "en", words: [{ word: "more", start: 0.1, end: 0.2, confidence: 0.9 }] });
	assert.equal(states.at(-1)!.value!.words, undefined, "dictation after a words-less answer has no verbatim timings");
	handle.dispose();
});

test("an unreadable or overlapping word list leaves delivery unavailable and still grades", async () => {
	const f = fixture({ interviewMode: true });
	try {
		const overlapping = { ...dictatedAnswer(), words: [{ word: "uh", start: 0.1, end: 0.5, confidence: 0.9 }, { word: "an", start: 0.3, end: 0.6, confidence: 0.97 }] };
		const result = await f.grade(gradingContext(overlapping));
		assert.deepEqual(result.delivery, { status: "unavailable", reason: "the dictation timings could not be read" });
		assert.deepEqual(result.gaps, literalResult.gaps);
	} finally {
		f.cleanup();
	}
});

test("the Jev request state carries only the delivery metric fields", async () => {
	const stub = await stubJsonServer((_request, response) => sendJson(response, 200, {
		model: "jev-1.14.0",
		answers: {
			...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: criteria[kind] }])),
			[DELIVERY_CRITERION]: { type: "noul", noul: criteria[DELIVERY_CRITERION] },
			fix: { type: "choice", choice: DELIVERY_CRITERION, confidence: 0.6, probabilities: criteria },
		},
	}));
	const f = fixture({ interviewMode: true, jevEndpoint: stub.url });
	try {
		await f.grade(gradingContext(dictatedAnswer()));
		const body = stub.requests[0]!.body as { state: { metrics: Record<string, unknown> } };
		assert.deepEqual(Object.keys(body.state.metrics).sort(), ["fillersPerMin", "pauses", "wordsPerMin"]);
	} finally {
		f.cleanup();
		await stub.close();
	}
});

test("a failed settings write leaves the in-memory delivery settings unchanged", () => {
	const f = fixture();
	try {
		fs.rmSync(f.dataDirectory, { recursive: true, force: true });
		fs.writeFileSync(f.dataDirectory, "not a directory");
		assert.throws(() => f.handlers.get("set-interview-mode")!({ mode: true }));
		assert.throws(() => f.handlers.get("set-pause-threshold")!({ seconds: 5 }));
		assert.deepEqual(f.handlers.get("get-settings")!(undefined), { hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 });
	} finally {
		f.cleanup();
		fs.rmSync(f.dataDirectory, { force: true });
	}
});
