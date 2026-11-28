import {
	clonePluginQuestionJson, freezePluginQuestionValue,
	type PluginQuestionAnswerState, type PluginQuestionEditorHandle,
	type PluginQuestionEditorKey, type PluginQuestionEditorProps,
	type PluginProblemEditorHandle, type PluginProblemEditorProps, type DictatedSpeech,
} from "../src/core/index.ts";

export function controlledPluginAnswer(value: PluginQuestionAnswerState): PluginQuestionAnswerState {
	if (!value || !["empty", "ready", "unready"].includes(value.status)) throw new Error("Invalid answer state");
	return value.status === "empty" ? Object.freeze({ status: "empty" }) : freezePluginQuestionValue({ status: value.status, value: clonePluginQuestionJson(value.value) });
}
type EditorHandle = Pick<PluginQuestionEditorHandle, "focus" | "dispose" | "handleKeyDown" | "appendTranscript"> & { update: unknown; wantsDictatedWords?: boolean; appendDictatedSpeech?: PluginQuestionEditorHandle["appendDictatedSpeech"] };
const optionalFunction = (value: unknown) => value === undefined || typeof value === "function";
function isEditorHandle(next: EditorHandle | null | undefined): boolean {
	return !!next && typeof next.update === "function" && typeof next.focus === "function" && typeof next.dispose === "function"
		&& optionalFunction(next.handleKeyDown) && optionalFunction(next.appendTranscript) && optionalFunction(next.appendDictatedSpeech);
}
/** Opted in to `{text, words}` delivery: the flag AND the callback. */
const wantsSpeech = (handle: EditorHandle | null) => handle?.wantsDictatedWords === true && typeof handle.appendDictatedSpeech === "function";
/** Both question and practice editors use one generation/cleanup authority. */
function createEditorLease<P, H extends EditorHandle>(options: {
	props(signal: AbortSignal, onChange: (state: PluginQuestionAnswerState) => void): P;
	update(handle: H, state: PluginQuestionAnswerState, active: boolean): void;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	let current = true;
	let handle: H | null = null;
	let publishedReady = false;
	const controller = new AbortController();
	const fail = () => { if (current) { options.failed(); dispose(); } };
	const props = options.props(controller.signal, state => {
		if (!current) return;
		try { const value = controlledPluginAnswer(state); options.publish(value); publishedReady = value.status === "ready"; options.changed(); }
		catch { fail(); }
	});
	function dispose() {
		if (!current) return;
		current = false; controller.abort();
		const old = handle; handle = null;
		try { old?.dispose(); } catch { /* unavailable host fallback already owns the surface */ }
		options.changed();
	}
	async function appendText(text: string) {
		if (!current || !handle?.appendTranscript) return;
		const adopted = handle;
		try { await adopted.appendTranscript!(text); } catch { fail(); }
	}
	async function appendSpeechValue(speech: DictatedSpeech) {
		if (!current || !handle) return;
		const adopted = handle;
		if (typeof adopted.appendDictatedSpeech === "function") {
			try { await adopted.appendDictatedSpeech(speech); } catch { fail(); }
			return;
		}
		await appendText(speech.text);
	}
	return {
		props,
		adopt(next: H) {
			if (!current) { try { next.dispose(); } catch {} return; }
			if (!isEditorHandle(next)) { try { if (typeof next?.dispose === "function") next.dispose(); } catch {} fail(); return; }
			handle = next; options.changed();
		},
		get ready() { return current && handle !== null && publishedReady; },
		get mounted() { return current && handle !== null; },
		get speech() { return current && (!!handle?.appendTranscript || wantsSpeech(handle)); },
		/** Opted in to `{text, words}` delivery (default false). */
		get wantsWords() { return current && wantsSpeech(handle); },
		update(state: PluginQuestionAnswerState, active: boolean) { if (current && handle) try { options.update(handle, state, active); } catch { fail(); } },
		focus() { if (current && handle) try { handle.focus(); } catch { fail(); } },
		key(key: PluginQuestionEditorKey): "handled" | "pass" { if (current && handle?.handleKeyDown) try { return handle.handleKeyDown(key) === "handled" ? "handled" : "pass"; } catch { fail(); } return "pass"; },
		append: appendText,
		appendSpeech(speech: DictatedSpeech) { if (current && wantsSpeech(handle)) return appendSpeechValue(speech); },
		/** Deliver a final whose opt-in was latched when the run started: a
		 *  mid-run flag removal falls back to plain text instead of dropping it. */
		appendLatchedSpeech: appendSpeechValue,
		fail, dispose,
	};
}
type LeaseOptions<P> = {
	props: P;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
};
/** The one lease shape both editors share: frozen props carrying the lease
 *  signal and onChange, plus the kind-specific `update` payload. */
function createFrozenPropsLease<P extends object, H extends EditorHandle>(
	options: LeaseOptions<P>,
	update: (handle: H, state: PluginQuestionAnswerState, active: boolean) => void,
) {
	return createEditorLease<P, H>({ ...options,
		props: (signal, onChange) => Object.freeze({ ...options.props, signal, onChange }) as P,
		update,
	});
}
export function createQuestionEditorLease(options: LeaseOptions<PluginQuestionEditorProps>) {
	return createFrozenPropsLease<PluginQuestionEditorProps, PluginQuestionEditorHandle>(options,
		(handle, answer, active) => handle.update({ answer, active }));
}
export function createProblemEditorLease(options: LeaseOptions<PluginProblemEditorProps>) {
	return createFrozenPropsLease<PluginProblemEditorProps, PluginProblemEditorHandle>(options,
		(handle, submission, active) => handle.update({ submission, active }));
}
export type QuestionEditorLease = ReturnType<typeof createQuestionEditorLease>;
export type ProblemEditorLease = ReturnType<typeof createProblemEditorLease>;
