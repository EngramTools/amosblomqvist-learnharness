"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { deepgramListenUrl, type DictatedSpeech, type DictatedWord, type DictationLanguage } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
import { dispatchFocusedPluginShortcut } from "@/components/plugin-input-focus";
export { isDictationActive } from "@/components/dictation-state";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
 *
 * Architecture (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket DIRECTLY (audio never loops
 * through our server) with a short-lived token minted by /api/stt/token
 * (the real key stays server-side), and streams frames while it listens.
 * Finals append into the PRIMARY INPUT (see below).
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying session's socket can never
 *     tear down the current one.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: mic dies FIRST (no more audio enqueues), then CloseStream,
 *     then a 3s safety net in case Deepgram never closes the socket.
 *   - interim_results=false, endpointing=300: his live-tuned params — no
 *     partial hypotheses, finals commit ~300ms after a pause (owner
 *     round 1: live words are distracting and shift the meter; the
 *     meter's width is FIXED while recording).
 *
 * Owner round 2 (2026-09-17, second live test):
 *   - DEFERRED transcript: finals accumulate in a buffer during the run
 *     and flush into the primary input ONCE, when the dictation ends
 *     (click-again/Esc → Deepgram flushes its last finals → socket close
 *     → one joined append). Nothing textual renders while recording —
 *     only the meter. Live output may return as a toggleable setting at
 *     the settings milestone; deferred is the only behavior for now.
 *   - ADAPTIVE meter: the strip's cell count derives from its measured
 *     width (4px pitch, 8–48 cells, ResizeObserver) so narrow rows (the
 *     draft view's tighter column) show fewer bars instead of
 *     overflowing under their neighbors.
 *
 * Owner round 1 (2026-09-17, first live mic test):
 *   - ONE primary transcription input at all times: the pending
 *     quiz/ask question's field while one waits (text mode → the answer
 *     field, select modes → "Your thinking"), else the page's composer.
 *     Implemented as a module-level registry the question form claims on
 *     mount — see useDictationTarget below.
 *   - Click → meter IMMEDIATELY (optimistic): the meter strip renders
 *     from the click, connection + TCC happen behind it. The token mint
 *     and the mic acquisition run CONCURRENTLY (Promise.all) to shrink
 *     the real gap.
 *
 * Meter rendering lives in <DictationBar> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * tiny bar strip repaints.
 *
 * Start-latency mitigation wave (owner, 2026-09-27 — A+B+C+D, the
 * optimistic meter stays): the old start path serialized [token ∥ mic] →
 * NEW AudioContext → addModule fetch → WSS handshake, and DROPPED every
 * frame that arrived before the socket was OPEN — the first seconds of
 * speech never reached Deepgram. Now:
 *   - QUEUE-DON'T-DROP (A): frames arriving before OPEN buffer (capped,
 *     oldest dropped) and flush in order on open — captured speech is
 *     never lost, wherever in setup it lands.
 *   - PARALLEL HANDSHAKE (B, mic-gated): the handshake starts the moment
 *     the capture graph is live, not after it. Mic-gated, NOT token-gated:
 *     an OS TCC prompt can outlive Deepgram's 10s idle timeout.
 *   - PERSISTENT GRAPH (C): one app-lifetime AudioContext + a memoized
 *     worklet module — per-run contexts paid context creation AND a
 *     worklet-module fetch on every start (through the dev server in dev).
 *   - WARM TOKEN (D): pre-minted at page mount and refreshed after every
 *     run (TTL 3min); the click no longer waits on the remote mint. A
 *     stale-token handshake failure self-heals via the reconnect-once
 *     path, which always mints FRESH.
 *   - The honest floor stays: getUserMedia can't be pre-warmed (the mic
 *     indicator would stay lit) — hence the owner's optimistic meter.
 */

/*
 * Deepgram streaming params (the owner's live-tuned dictate config): nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
// URL construction lives in the browser-safe core; only language varies.

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak ("add it to auth.json
 * (desktop) or .env.local (dev)") — the surface says the short truth
 * instead. Exported for pins; the errored idle button's click recognizes
 * it and deep-links Settings → Keys → the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";
export const DICTATION_ACTIVE_ELSEWHERE = "Dictation is active elsewhere";

// Mounted controllers do not claim capture. Only start() acquires the single
// window-wide owner, synchronously, before settings/mic/token awaits.
let recordingOwner: symbol | null = null;
let recordingTarget: ((text: string) => unknown) | null = null;
const controllers = new Map<symbol, { primary: boolean; toggle: () => void; cancel: () => void }>();
function toggleGlobalDictation() {
	if (dispatchFocusedPluginShortcut("toggle-dictation")) return;
	for (const controller of controllers.values()) {
		if (controller.primary) {
			controller.toggle();
			return;
		}
	}
}
function cancelGlobalDictation() {
	if (recordingOwner) controllers.get(recordingOwner)?.cancel();
}
function registerController(id: symbol, controller: { primary: boolean; toggle: () => void; cancel: () => void }) {
	if (controllers.size === 0) {
		window.addEventListener("lh:kbd-toggle-dictation", toggleGlobalDictation);
		window.addEventListener("lh:kbd-cancel-dictation", cancelGlobalDictation);
	}
	controllers.set(id, controller);
	return () => {
		controllers.delete(id);
		if (controllers.size === 0) {
			window.removeEventListener("lh:kbd-toggle-dictation", toggleGlobalDictation);
			window.removeEventListener("lh:kbd-cancel-dictation", cancelGlobalDictation);
		}
	};
}

/** Mint a fresh short-lived token (the route holds the real key
 *  server-side). Module-level: the start path's warm cache and the
 *  reconnect path both bottom out here. The keyless 503 (no
 *  DEEPGRAM_API_KEY) is the route's ONLY 503 — the raw message is
 *  dev-speak, so the error becomes the short client-authored line
 *  (zero-keys wave, owner 2026-09-25). */
async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void | Promise<void>) | null = null;
/** The current question target's `{text, words}` receiver, set only when its
 *  editor opted into per-word timings. Null means text-only. */
let questionTargetSpeech: ((speech: DictatedSpeech) => void | Promise<void>) | null = null;
let composerTarget: ((text: string) => void) | null = null;

/** File references use the very same default destination as dictation,
 * including claims whose dock is currently collapsed. A focused editor can
 * insert at its caret instead; callers use this only as the fallback. */
export function appendToPrimaryInput(text: string): boolean {
	const target = questionTarget ?? composerTarget;
	if (!target) return false;
	target(text);
	return true;
}

/* The CORE finisher registry: the pending question's dock needs finish()
 * without a prop bridge. Explicit plugin controllers never register here;
 * their submit paths await their own controller.finish(). */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish the core page's dictation before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function usePluginQuestionDictationTarget(append: (text: string) => void | Promise<void>, claimed: boolean, appendSpeech?: (speech: DictatedSpeech) => void | Promise<void>) {
	// The text target owns the claim and its cancel-on-replacement cleanup.
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) {
				// Cancel/discard an obsolete capture before releasing its destination.
				if (recordingTarget === append) cancelGlobalDictation();
				questionTarget = null;
				questionTargetSpeech = null;
			}
		};
	}, [append, claimed]);
	// Speech opt-in changes must not cancel a live run: the engine latches its
	// receiver at start, and the dock falls back to plain text if the editor
	// revokes the flag before the final lands.
	useEffect(() => {
		if (claimed && questionTarget === append) questionTargetSpeech = appendSpeech ?? null;
	}, [append, claimed, appendSpeech]);
}

export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		// A plain claimant owns no speech receiver: claiming drops the previous
		// claimant's, so releasing has nothing left to clear.
		questionTarget = append;
		questionTargetSpeech = null;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

/** One Deepgram word: the declared fields plus any `punctuated_word`/extras. */
type DeepgramWord = DictatedWord & { readonly punctuated_word?: string };

/** A final's words mapped to the public shape when the run opted in to word
 *  timings; nothing otherwise. Extra Deepgram fields never escape. */
function finalWords(optedIn: unknown, alternative: { words?: readonly DeepgramWord[] } | undefined): DictatedWord[] {
	if (!optedIn) return [];
	return (alternative?.words ?? []).map(({ word, start, end, confidence }) => ({ word, start, end, confidence }));
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export interface DictationDestination {
	id: string;
	append: (text: string) => void | Promise<void>;
	/** Opt-in: when present the run delivers `{text, words}` here instead of
	 *  text to `append`, and requests filler words for monolingual English. */
	appendSpeech?: (speech: DictatedSpeech) => void | Promise<void>;
}

export type Dictation = {
	phase: DictationPhase;
	/** One shared recorder; an explicit side destination never claims the main input. */
	destinationId: string;
	blocked?: boolean;
	toggleFor: (destination: DictationDestination) => void;
	finishFor: (destinationId: string) => Promise<void>;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — Deepgram's last finals have landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  settles the waiters. Cancel (Esc) normally resolves after discarding
	 *  buffered speech; cancel/dispose during asynchronous transcript delivery
	 *  rejects instead, so a waiting submit cannot send stale text. */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
};

type Ref<T> = { current: T };

/** A run's failed transcript delivery, kept so a later finish() can report it. */
type Failure = { error: unknown };

/** The transcript of the live run (owner round 2: finals land here during the
 *  run and flush into the target once, at teardown). Mutable by design: one
 *  object per hook, reset at every start. */
type Transcript = {
	/** The deferred finals, in order. */
	buffer: string[];
	/** Word timings of every final, in final order (opt-in delivery). Only
	 *  opted-in runs fill it — no extra retention on the default path. */
	words: DictatedWord[];
	/** The live run's `{text, words}` receiver, fixed at start; the URL and
	 *  delivery shape key off it. Undefined by default — every unchanged
	 *  target keeps text-only. */
	speech: DictationDestination["appendSpeech"];
	/** The resolved language of the live run, captured at start so the flush
	 *  can attach it to the opted-in `{text, words}` delivery. */
	language: DictationLanguage | undefined;
};

/** Live capture machinery (non-render values). The MediaStream tracks stop and
 *  the per-run nodes disconnect on teardown; the socket is recreated per run;
 *  the AudioContext is app-lifetime (mitigation C). */
type CaptureState = {
	ws: WebSocket | null;
	stream: MediaStream | null;
	/** Per-run graph nodes — the CONTEXT outlives runs (mitigation C). */
	source: MediaStreamAudioSourceNode | null;
	worklet: AudioWorkletNode | null;
	/** Frames captured before the socket is OPEN (mitigation A): flushed in
	 *  order on open; capped at MAX_PENDING_FRAMES with the oldest dropped;
	 *  cleared at teardown so a dead run's audio can't leak into the next. */
	pending: ArrayBuffer[];
	safety: ReturnType<typeof setTimeout> | null;
	reconnects: number;
};

/** How a finished run reaches the callers waiting on it. */
type Settlement = {
	/** Resolvers waiting for the run to fully end (finish(), owner
	 *  2026-10-01): released by cleanup() — every terminal path runs it. */
	waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
	failure: Failure | null;
	/** An asynchronous transcript delivery is still in flight. */
	pending: boolean;
};

type RunState = {
	/** Stale-handler guard (dictate pattern). */
	gen: number;
	destination: DictationDestination | null;
	transcript: Transcript;
	capture: CaptureState;
	settlement: Settlement;
};

/** Everything the run hooks share that is not run state: identity, the
 *  render-visible setters, and the always-fresh inputs. */
type RunIo = {
	owner: symbol;
	primary: boolean;
	phaseRef: Ref<DictationPhase>;
	/** Fresh fallback for the next start; a live run retains its own target. */
	appendRef: Ref<(text: string) => void>;
	disabledRef: Ref<boolean>;
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	levelRef: Ref<number>;
	setPhase: (next: DictationPhase) => void;
	setError: (message: string | null) => void;
	setDestinationId: (id: string) => void;
};

/** Frames kept while the socket is not OPEN (≈32s of audio). */
const MAX_PENDING_FRAMES = 256;

function newRunState(): RunState {
	return {
		gen: 0,
		destination: null,
		transcript: { buffer: [], words: [], speech: undefined, language: undefined },
		capture: { ws: null, stream: null, source: null, worklet: null, pending: [], safety: null, reconnects: 0 },
		settlement: { waiters: [], failure: null, pending: false },
	};
}

function useLatest<T>(value: T): Ref<T> {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}

/** Fresh run, fresh transcript; the opt-in receiver is read once per run. */
function resetTranscript(t: Transcript, speech: DictationDestination["appendSpeech"]): void {
	t.buffer = [];
	t.words = [];
	t.speech = speech;
	t.language = undefined; // resolved once the preference lands
}

function discardTranscript(t: Transcript): void {
	t.buffer = [];
	t.words = [];
}

/** Flush into this run's fixed destination. Called exactly once at cleanup;
 *  the buffer clears itself so double-cleanup is a no-op. */
function flushTranscript(t: Transcript, destination: DictationDestination): unknown {
	if (t.buffer.length === 0) return;
	const text = t.buffer.join(" ");
	const words = t.words;
	discardTranscript(t);
	return t.speech ? t.speech({ text, words, ...(t.language ? { language: t.language } : {}) }) : destination.append(text);
}

type DeepgramMessage = {
	type?: string;
	is_final?: boolean;
	channel?: { alternatives?: Array<{ transcript?: string; words?: readonly DeepgramWord[] }> };
};

function parseMessage(data: string): DeepgramMessage | null {
	try {
		return JSON.parse(data) as DeepgramMessage | null;
	} catch {
		return null;
	}
}

/** Only finals stream (interim_results=false). DEFERRED (owner round 2): they
 *  buffer here and reach the input once, at teardown — the meter is the only
 *  live feedback. */
function ingestMessage(t: Transcript, data: string): void {
	const msg = parseMessage(data);
	if (msg?.type !== "Results" || !msg.is_final) return;
	const alternative = msg.channel?.alternatives?.[0];
	if (!alternative?.transcript) return;
	t.buffer.push(alternative.transcript);
	t.words.push(...finalWords(t.speech, alternative));
}

/** Mic dies FIRST — no more audio enqueues (dictate pattern). The per-run
 *  nodes die with it; the AudioContext stays (mitigation C). */
function stopMic(c: CaptureState): void {
	for (const track of c.stream?.getTracks() ?? []) track.stop();
	c.stream = null;
	c.source?.disconnect();
	c.source = null;
	c.worklet?.disconnect();
	c.worklet = null;
}

function isLiveSocket(ws: WebSocket): boolean {
	return ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING;
}

function closeSocket(c: CaptureState): void {
	const ws = c.ws;
	c.ws = null;
	if (!ws || !isLiveSocket(ws)) return;
	try {
		ws.close();
	} catch {}
}

function releaseCapture(c: CaptureState): void {
	if (c.safety) {
		clearTimeout(c.safety);
		c.safety = null;
	}
	c.pending = [];
	stopMic(c);
	closeSocket(c);
}

/** Mitigation A: everything captured during the handshake (or a reconnect
 *  gap) goes out now, in order — Deepgram accepts faster-than-realtime sends. */
function sendPendingAudio(c: CaptureState, ws: WebSocket): void {
	for (const frame of c.pending) ws.send(frame);
	c.pending = [];
}

/** Send when the socket is open; otherwise (handshake or reconnect gap) queue,
 *  capped — the open handler flushes in order. */
function sendOrQueueAudio(c: CaptureState, buffer: ArrayBuffer): void {
	if (c.ws && c.ws.readyState === WebSocket.OPEN) {
		c.ws.send(buffer);
		return;
	}
	c.pending.push(buffer);
	if (c.pending.length > MAX_PENDING_FRAMES) c.pending.shift();
}

/** Route one capture-worklet message for `gen`: levels always update; audio
 *  goes out or queues. A message from a dead run is ignored. */
function routeCaptureMessage(run: RunState, levelRef: Ref<number>, gen: number, data: unknown): void {
	if (gen !== run.gen) return;
	const msg = data as { type: string; rms?: number; buffer?: ArrayBuffer };
	if (msg.type === "level") levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
	else if (msg.type === "audio" && msg.buffer) sendOrQueueAudio(run.capture, msg.buffer);
}

/** Wire the capture worklet to the run. Resolves false when the run went
 *  stale while the shared graph was warming up. */
async function attachCaptureGraph(c: CaptureState, stream: MediaStream, isStale: () => boolean, onMessage: (data: unknown) => void): Promise<boolean> {
	// Mitigation C: app-lifetime context + memoized worklet module — per-run
	// costs (context creation, module fetch) are gone.
	const { ctx, module } = ensureAudioGraph();
	await module;
	if (ctx.state === "suspended") await ctx.resume();
	if (isStale()) return false;

	const worklet = new AudioWorkletNode(ctx, "pcm-capture");
	c.worklet = worklet;
	worklet.port.onmessage = (e) => onMessage(e.data);
	const source = ctx.createMediaStreamSource(stream);
	c.source = source;
	source.connect(worklet);
	// Pull the graph with silence out (the worklet writes no output) —
	// an unconnected worklet node is never clocked.
	worklet.connect(ctx.destination);
	return true;
}

const MIC_DENIED_ERRORS = new Set(["NotAllowedError", "SecurityError"]);

function micErrorMessage(e: unknown): string {
	if (e instanceof DOMException && MIC_DENIED_ERRORS.has(e.name)) return "Microphone permission denied";
	return e instanceof Error ? e.message : "mic unavailable";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

/** Flush the transcript into the run's destination. A second cleanup
 *  (cancel/dispose) cannot turn an unfinished async append into a successful
 *  finish: that would send the old draft. */
function flushRun(run: RunState, fallback: (text: string) => void): { appended: unknown; failure: Failure | null } {
	const { settlement } = run;
	let failure: Failure | null = settlement.pending
		? { error: new DOMException("Dictation transcript delivery canceled", "AbortError") }
		: null;
	settlement.pending = false;
	let appended: unknown;
	try {
		appended = flushTranscript(run.transcript, run.destination ?? { id: "main", append: fallback }); // exactly one append, after the final transcript
	} catch (error) {
		failure = { error };
	}
	return { appended, failure };
}

/** The run is over: release the window-wide owner, go idle, settle waiters. */
function settleRun(settlement: Settlement, io: RunIo, failed: Failure | null, warmNext: boolean): void {
	settlement.pending = false;
	settlement.failure = failed;
	if (failed) io.setError(failed.error instanceof Error ? failed.error.message : "Dictation transcript could not be applied");
	if (recordingOwner === io.owner) {
		recordingOwner = null;
		recordingTarget = null;
		setDictationActive(false);
	}
	io.setPhase("idle");
	// A plugin's async onTranscript is part of finishing, not a
	// fire-and-forget notification: send must see its controlled text.
	for (const waiter of settlement.waiters.splice(0)) {
		if (failed) waiter.reject(failed.error);
		else waiter.resolve();
	}
	if (warmNext) warmTokens.refresh();
}

/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
function cleanupRun(run: RunState, io: RunIo, warmNext: boolean): void {
	const endGen = ++run.gen;
	const { appended, failure } = flushRun(run, io.appendRef.current);
	releaseCapture(run.capture);
	const complete = (failed: Failure | null) => {
		if (endGen === run.gen) settleRun(run.settlement, io, failed, warmNext);
	};
	if (!isThenable(appended)) {
		complete(failure);
		return;
	}
	run.settlement.pending = true;
	io.setPhase("stopping");
	// Both branches consume the promise, including stop-without-finish.
	void Promise.resolve(appended).then(() => complete(null), (error: unknown) => complete({ error }));
}

type Cleanup = (warmNext?: boolean) => void;

/** A run's state, its shared io and its teardown, bound together for the
 *  functions that drive a live run. */
type RunCtx = { run: RunState; io: RunIo; cleanup: Cleanup };

function useRunCleanup(run: RunState, io: RunIo): Cleanup {
	return useCallback((warmNext = true) => cleanupRun(run, io, warmNext), [run, io]);
}

/** ONE reconnect with a fresh token (the research pass: resume is our job, no
 *  SDK to lean on) after an abnormal close mid-run. */
function reconnectSocket(ctx: RunCtx, gen: number, code: number, language: DictationLanguage): void {
	const { run, io, cleanup } = ctx;
	if (run.capture.reconnects >= 1) {
		io.setError(`Deepgram connection lost (${code})`);
		cleanup();
		return;
	}
	run.capture.reconnects++;
	mintFreshToken() // always FRESH — a stale warm token is the likely culprit
		.then((token) => {
			if (gen === run.gen) openSocket(ctx, gen, token, language);
		})
		.catch(() => {
			if (gen !== run.gen) return;
			io.setError("Deepgram reconnect failed");
			cleanup();
		});
}

/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
function openSocket(ctx: RunCtx, gen: number, token: string, language: DictationLanguage): void {
	const { run, io, cleanup } = ctx;
	// Minted JWTs authenticate via the "bearer" subprotocol — ["token",
	// jwt] is rejected at the handshake (verified live; "token" is for
	// raw API keys only, as in the owner's pi dictate extension).
	// deepgramListenUrl keeps filler_words English-only.
	const ws = new WebSocket(deepgramListenUrl(language, { fillerWords: !!run.transcript.speech }), ["bearer", token]);
	run.capture.ws = ws;
	ws.addEventListener("open", () => {
		if (gen !== run.gen) return;
		sendPendingAudio(run.capture, ws);
		io.setPhase("recording");
	});
	ws.addEventListener("message", (ev) => {
		if (gen === run.gen) ingestMessage(run.transcript, ev.data as string);
	});
	ws.addEventListener("close", (ev) => {
		if (gen !== run.gen) return;
		// Code 1000 is our own CloseStream landing: finalize now — the stop
		// path's safety net stays as the no-close backstop only.
		if (ev.code === 1000) cleanup();
		else reconnectSocket(ctx, gen, ev.code, language);
	});
}

/** Where the run delivers when no explicit destination was given. */
function defaultTarget(io: RunIo): DictationDestination {
	const append = io.primary ? questionTarget ?? io.appendRef.current : (text: string) => io.appendRef.current(text);
	return { id: "main", append };
}

/** Opt-in is read once per run: an explicit destination carries its own
 *  receiver; the default question target carries the plugin editor's.
 *  The core owns the language gate: filler_words is requested for
 *  monolingual English only, and word timings are kept for any language. */
function runSpeech(destination: DictationDestination | undefined, primary: boolean): DictationDestination["appendSpeech"] {
	if (destination) return destination.appendSpeech;
	return primary ? questionTargetSpeech ?? undefined : undefined;
}

/** Synchronously claim the window-wide owner and reset the run, before any
 *  settings/mic/token await. Returns the run's generation. */
function beginRun(run: RunState, io: RunIo, destination?: DictationDestination): number {
	const target = destination ?? defaultTarget(io);
	run.destination = target;
	resetTranscript(run.transcript, runSpeech(destination, io.primary));
	io.setDestinationId(target.id);
	recordingOwner = io.owner;
	recordingTarget = target.append;
	setDictationActive(true);
	io.setError(null);
	run.settlement.failure = null;
	io.setPhase("connecting");
	run.capture.reconnects = 0;
	run.capture.pending = []; // fresh run, fresh queue (mitigation A)
	return ++run.gen;
}

/** A failed start step ends its run here; a stale one was already ended elsewhere. */
function failStart({ run, io, cleanup }: RunCtx, gen: number, message: string): void {
	if (gen !== run.gen) return;
	io.setError(message);
	cleanup();
}

function errorText(e: unknown, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}

/** Open the mic and wire the capture graph. The mic is the long pole
 *  (macOS HAL + APM init) and gates everything — the token runs
 *  concurrently with it. 127.0.0.1 is a secure context, so getUserMedia
 *  works without TLS; macOS TCC prompts on first use. */
async function startCapture(ctx: RunCtx, gen: number): Promise<boolean> {
	const { run, io } = ctx;
	const isStale = () => gen !== run.gen;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		if (isStale()) {
			for (const track of stream.getTracks()) track.stop();
			return false;
		}
		run.capture.stream = stream;
		const attached = await attachCaptureGraph(run.capture, stream, isStale, (data) => routeCaptureMessage(run, io.levelRef, gen, data));
		return attached && !isStale();
	} catch (e) {
		failStart(ctx, gen, micErrorMessage(e));
		return false;
	}
}

/** Await one start step; null ends the start (failed, or its run went stale). */
async function settleStep<T>(ctx: RunCtx, gen: number, step: Promise<T>, failure: string): Promise<T | null> {
	try {
		const value = await step;
		return gen === ctx.run.gen ? value : null;
	} catch (e) {
		failStart(ctx, gen, errorText(e, failure));
		return null;
	}
}

async function startRun(ctx: RunCtx, getLanguage: () => Promise<DictationLanguage>, destination?: DictationDestination): Promise<void> {
	const { run, io } = ctx;
	if (io.disabledRef.current || io.phaseRef.current !== "idle") return;
	if (recordingOwner !== null && recordingOwner !== io.owner) {
		io.setError(DICTATION_ACTIVE_ELSEWHERE);
		return;
	}
	const gen = beginRun(run, io, destination);
	const language = await settleStep(ctx, gen, getLanguage(), "Dictation language unavailable");
	if (language === null) return;
	run.transcript.language = language;

	// Mitigation D: the warm token (pre-minted at mount / after the last
	// run) resolves ~instantly; a cold/keyless mint surfaces below.
	const tokenPromise = warmTokens.mint();
	tokenPromise.catch(() => {}); // surfaced below; no unhandled rejection
	if (!(await startCapture(ctx, gen))) return;
	const token = await settleStep(ctx, gen, tokenPromise, "token unavailable");
	if (token === null) return;
	// Mitigation B: the handshake fires the moment the graph is live,
	// overlapping any remaining token wait — mic-gated, never before it.
	openSocket(ctx, gen, token, language);
}

function useRunStart(ctx: RunCtx) {
	const { getLanguage } = useDictationLanguage();
	return useCallback((destination?: DictationDestination) => startRun(ctx, getLanguage, destination), [ctx, getLanguage]);
}

const isActivePhase = (io: RunIo) => io.phaseRef.current === "recording" || io.phaseRef.current === "connecting";

function stopRun(run: RunState, io: RunIo, cleanup: Cleanup): void {
	const gen = run.gen;
	if (!isActivePhase(io)) return;
	io.setPhase("stopping");
	stopMic(run.capture);
	const ws = run.capture.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		cleanup();
		return;
	}
	try {
		ws.send(JSON.stringify({ type: "CloseStream" }));
	} catch {
		cleanup();
		return;
	}
	// Deepgram flushes remaining finals then closes; if it never
	// does, the safety net ends the run anyway (dictate pattern).
	run.capture.safety = setTimeout(() => {
		if (gen === run.gen) cleanup();
	}, 3000);
}

function cancelRun(run: RunState, io: RunIo, cleanup: Cleanup): void {
	if (io.phaseRef.current === "idle") return;
	// Discard first, teardown second — cleanup() flushes, and the now-empty
	// buffer makes that flush a no-op. Also kills a "stopping" run: the
	// flush already underway is abandoned (its timer is cleared inside).
	discardTranscript(run.transcript);
	cleanup();
}

/** FINISH, THEN CONTINUE: resolve once the live run has fully ended. */
function finishRun(run: RunState, io: RunIo, stop: () => void): Promise<void> {
	return new Promise((resolve, reject) => {
		if (io.phaseRef.current === "idle") {
			if (run.settlement.failure) reject(run.settlement.failure.error);
			else resolve();
			return;
		}
		run.settlement.waiters.push({ resolve, reject });
		// "stopping" is already ending — the waiter just rides to cleanup.
		if (isActivePhase(io)) stop();
	});
}

function useRunControls({ run, io, cleanup }: RunCtx, start: (destination?: DictationDestination) => Promise<void>) {
	const stop = useCallback(() => stopRun(run, io, cleanup), [run, io, cleanup]);
	const cancel = useCallback(() => cancelRun(run, io, cleanup), [run, io, cleanup]);
	const finishCurrent = useCallback(() => finishRun(run, io, stop), [run, io, stop]);
	const finishFor = useCallback((id: string) => run.destination?.id === id ? finishCurrent() : Promise.resolve(), [run, finishCurrent]);
	// A main submission must not stop or wait for side-input recording.
	const finish = useCallback(() => finishFor("main"), [finishFor]);
	const toggleFor = useCallback((destination?: DictationDestination) => {
		if (io.phaseRef.current === "idle") void start(destination);
		else stop();
		// Focus chooses where to START. An active run always stops into its
		// original destination, even after focus moves to a different field.
	}, [io, start, stop]);
	const toggle = useCallback(() => toggleFor(), [toggleFor]);
	return { stop, cancel, finish, finishFor, toggleFor, toggle };
}

/** The composer is the fallback target of every primary hook. */
function useComposerTarget(primary: boolean, appendRef: Ref<(text: string) => void>) {
	useEffect(() => {
		if (!primary) return;
		const target = (text: string) => appendRef.current(text);
		composerTarget = target;
		return () => {
			if (composerTarget === target) composerTarget = null;
		};
	}, [primary, appendRef]);
}

/** Render state plus the always-fresh inputs every run hook reads. */
function useRunIo(primary: boolean, append: (text: string) => void, disabled: boolean) {
	const owner = useRef(Symbol("dictation")).current;
	const [phase, setPhaseState] = useState<DictationPhase>("idle");
	const [destinationId, setDestinationId] = useState("main");
	const [error, setError] = useState<string | null>(null);
	const phaseRef = useRef<DictationPhase>("idle");
	const levelRef = useRef(0);
	const appendRef = useLatest(append);
	const disabledRef = useLatest(disabled);
	const io = useMemo<RunIo>(() => ({
		owner, primary, phaseRef, appendRef, disabledRef, levelRef, setError, setDestinationId,
		setPhase: (next) => {
			phaseRef.current = next;
			setPhaseState(next);
		},
	}), [owner, primary, appendRef, disabledRef]);
	return { io, phase, destinationId, error };
}

/** Page-lifetime registrations: the finisher the sibling subtrees (the pending
 *  question's dock) call, the mount warm-up with its navigation teardown, and
 *  the shared keyboard controller. */
function useDictationLifecycle({ run, io, cleanup }: RunCtx, controls: ReturnType<typeof useRunControls>) {
	const { finish, toggle, cancel } = controls;
	useEffect(() => {
		if (!io.primary) return;
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish, io.primary]);
	// One shared pair of shortcut listeners, regardless of widget count:
	// focused plugin control first, otherwise core fallback; Esc always
	// cancels the actual recording owner rather than the focused widget.
	useEffect(() => {
		warmTokens.refresh(); // pre-mint at mount (mitigation D) — silent if keyless
		return () => {
			// Navigation cancels capture: invalidate every pending await before
			// releasing resources, and never append into a different page's input.
			discardTranscript(run.transcript);
			cleanup(false);
		};
	}, [run, cleanup]);
	useEffect(() => registerController(io.owner, { primary: io.primary, toggle, cancel }), [io.owner, io.primary, toggle, cancel]);
}

/**
 * Shared capture engine with one synchronous window-wide recording owner.
 * Each primary run captures its main/question or explicit side destination.
 * Explicit plugin controllers never claim the primary target or finisher;
 * their asynchronous transcript delivery is part of finishing.
 */
export function useDictation({ append, destination = "primary", disabled = false }: {
	append: (text: string) => void;
	/** Explicit destinations never register or consult the core primary target. */
	destination?: "primary" | "explicit";
	disabled?: boolean;
}): Dictation {
	const primary = destination === "primary";
	const { io, phase, destinationId, error } = useRunIo(primary, append, disabled);
	useComposerTarget(primary, io.appendRef);
	const [run] = useState(newRunState);
	const cleanup = useRunCleanup(run, io);
	const ctx = useMemo<RunCtx>(() => ({ run, io, cleanup }), [run, io, cleanup]);
	const start = useRunStart(ctx);
	const controls = useRunControls(ctx, start);
	useDictationLifecycle(ctx, controls);

	return {
		phase,
		destinationId,
		toggleFor: controls.toggleFor,
		finishFor: controls.finishFor,
		error,
		levelRef: io.levelRef,
		active: phase !== "idle",
		toggle: controls.toggle,
		stop: controls.stop,
		finish: controls.finish,
		cancel: controls.cancel,
		clearError: () => io.setError(null),
	};
}

/** The idle Dictate button: a wide, quiet full-width affordance; an error
 *  swaps the label, and the caller decides whether a press retries or opens
 *  Settings → Keys. */
function DictationIdleButton({ error, disabled, onPress }: {
	error: string | null;
	disabled: boolean;
	onPress: () => void;
}) {
	return (
		<Hint
			// The error line truncates in the button; its tooltip reveals it.
			label={error ?? "Dictate"}
			action={error ? undefined : "toggle-dictation"}
			side="top"
		>
			<button
				type="button"
				onClick={onPress}
				disabled={disabled}
				aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
				data-testid="dictation-toggle"
				className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
			>
				<MicIcon className="size-3.5" />
				<span className="max-w-full truncate">{error ?? "Dictate"}</span>
			</button>
		</Hint>
	);
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             Deepgram flushes the last final.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation, disabled = false }: { dictation: Dictation; disabled?: boolean }) {
	const { phase, error, levelRef, toggle, active, clearError, blocked } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the Deepgram row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	/** Adaptive cell count (owner round 2): derived from the meter's
	 *  measured width — narrow rows show fewer bars instead of
	 *  overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	const pressIdle = () => {
		if (!keyless) {
			toggle();
			return;
		}
		clearError();
		openSettings("keys", DEEPGRAM_KEY_ID);
	};

	if (!active) {
		return <DictationIdleButton error={error} disabled={disabled || !!blocked} onPress={pressIdle} />;
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint label="Stop dictation (Esc)" side="top">
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
					data-testid="dictation-toggle"
					className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
				>
					{phase === "stopping" ? <Loader2Icon className="size-3.5 animate-spin" /> : <MicIcon className="size-3.5" />}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
