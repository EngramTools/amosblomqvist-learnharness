import type { CoachLocale } from "./judge-types.ts";
import type { ReferenceAudioResult } from "./reference-tts.ts";

export type ReferenceAudioSettings = { configured: boolean; region: string };

export type ReferenceAudioPlayerDeps = {
  call: (operation: string, input?: unknown) => Promise<unknown>;
  readInput: () => { text: string; locale: CoachLocale };
  button: HTMLButtonElement;
  status: HTMLParagraphElement;
  audio: HTMLAudioElement;
  isLive: () => boolean;
  /** Test seam; the browser plays a data URL through the audio element. */
  playAudio?: (source: string) => Promise<void>;
};

const MISSING_KEY = "Add an Azure Speech key in Language coach settings.";
const MISSING_REGION = "Add an Azure Speech region in Language coach settings.";
const NEEDS_TEXT = "Enter the reference text before playing.";
const UNREADABLE = "The reference audio could not be read.";
const LOADING = "Loading reference audio…";
const PLAYING = "Playing reference audio.";
const CACHED = "Playing cached reference audio.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readReferenceAudio(value: unknown): ReferenceAudioResult {
  if (!record(value)) throw new Error(UNREADABLE);
  if (value.status === "unavailable" && typeof value.reason === "string") {
    return { status: "unavailable", reason: value.reason };
  }
  if (
    value.status === "ok"
    && typeof value.audioBase64 === "string" && value.audioBase64
    && typeof value.contentType === "string"
    && typeof value.voice === "string"
    && typeof value.cached === "boolean"
  ) {
    return {
      status: "ok",
      audioBase64: value.audioBase64,
      contentType: value.contentType,
      voice: value.voice,
      cached: value.cached,
    };
  }
  throw new Error(UNREADABLE);
}

function playInBrowser(audio: HTMLAudioElement, source: string): Promise<void> {
  audio.src = source;
  return typeof audio.play === "function" ? audio.play() : Promise.resolve();
}

/** One play at a time; a missing key or a failed synthesis disables the button with its reason. */
export function createReferenceAudioPlayer(deps: ReferenceAudioPlayerDeps) {
  const { button, status, audio } = deps;
  let configReason = "";
  let failureReason = "";
  let busy = false;

  const show = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("lh-language-coach-settings__status-error", error);
  };

  const disable = (reason: string) => {
    button.disabled = true;
    show(reason, true);
  };

  const applyState = () => {
    const reason = configReason || failureReason;
    if (reason) disable(reason);
    else if (!busy) button.disabled = false;
  };

  const setAvailable = (settings: ReferenceAudioSettings) => {
    configReason = !settings.configured ? MISSING_KEY : !settings.region ? MISSING_REGION : "";
    if (configReason) disable(configReason);
    else if (!failureReason) {
      show("");
      if (!busy) button.disabled = false;
    }
  };

  /** A changed text or language is a new attempt, so a previous failure no longer applies. */
  const reset = () => {
    failureReason = "";
    show("");
    applyState();
  };

  const fail = (reason: string) => {
    failureReason = reason;
    disable(reason);
  };

  const present = async (result: ReferenceAudioResult): Promise<void> => {
    if (result.status === "unavailable") {
      fail(result.reason);
      return;
    }
    await (deps.playAudio ?? (source => playInBrowser(audio, source)))(
      `data:${result.contentType};base64,${result.audioBase64}`,
    );
    if (deps.isLive()) show(result.cached ? CACHED : PLAYING);
  };

  const play = async () => {
    if (busy || button.disabled) return;
    const { text, locale } = deps.readInput();
    if (!text) {
      show(NEEDS_TEXT, true);
      return;
    }
    busy = true;
    failureReason = "";
    button.disabled = true;
    show(LOADING);
    try {
      const result = readReferenceAudio(await deps.call("get-reference-audio", { text, locale }));
      if (deps.isLive()) await present(result);
    } catch (error) {
      if (deps.isLive()) fail(error instanceof Error ? error.message : UNREADABLE);
    } finally {
      busy = false;
      if (deps.isLive()) applyState();
    }
  };

  const dispose = () => {
    audio.removeAttribute("src");
    if (typeof audio.pause === "function") audio.pause();
  };

  return { play, reset, setAvailable, dispose };
}
