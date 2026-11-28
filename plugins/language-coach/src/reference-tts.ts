import type { CoachLocale } from "./judge-types.ts";
import { pronunciationFor, type PronunciationOk } from "./pronunciation.ts";
import {
  readCachedReferenceAudio,
  referenceAudioKey,
  writeCachedReferenceAudio,
} from "./reference-audio-cache.ts";

/** One short phrase per request; a stall must not hold the play button open. */
export const REFERENCE_TTS_TIMEOUT_MS = 20_000;
export const REFERENCE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
export const MAX_REFERENCE_AUDIO_BYTES = 4 * 1024 * 1024;

const AUDIO_CONTENT_TYPE = "audio/mpeg";
const MISSING_KEY = "Add an Azure Speech key in Language coach settings.";
const MISSING_REGION = "Add an Azure Speech region in Language coach settings.";

export type ReferenceTtsRuntime = {
  /** Test-only transport override; the host always activates without it. */
  endpointBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Test-only bound on cached phrases; the host always uses the default. */
  maxCacheEntries?: number;
};

export type ReferenceTtsOptions = ReferenceTtsRuntime & {
  subscriptionKey: string;
  region: string;
  voice: string;
  text: string;
  locale: CoachLocale;
  cacheDirectory: string;
};

export type ReferenceAudioOk = {
  status: "ok";
  audioBase64: string;
  contentType: string;
  voice: string;
  cached: boolean;
};

export type ReferenceAudioUnavailable = { status: "unavailable"; reason: string };
export type ReferenceAudioResult = ReferenceAudioOk | ReferenceAudioUnavailable;

type AzureAudio = { status: "ok"; audio: Uint8Array };
type AzureResult = AzureAudio | ReferenceAudioUnavailable;
type AzureRequest = {
  endpoint: string;
  subscriptionKey: string;
  ssml: string;
  timeoutMs: number;
  fetch: typeof fetch;
};

function unavailable(reason: string): ReferenceAudioUnavailable {
  return { status: "unavailable", reason };
}

function endpointFor(region: string, base?: string): string {
  return `${(base ?? `https://${region}.tts.speech.microsoft.com`).replace(/\/+$/, "")}/cognitiveservices/v1`;
}

function ssmlFor(pronunciation: PronunciationOk, locale: CoachLocale, voice: string): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`
    + `<voice name="${voice}">${pronunciation.markup}</voice></speak>`;
}

async function discardBody(response: Response): Promise<void> {
  try { await response.arrayBuffer(); } catch { /* connection cleanup best-effort */ }
}

async function readAudioResponse(response: Response, timedOut: () => boolean): Promise<AzureResult> {
  if (!response.ok) {
    await discardBody(response);
    return unavailable(`Azure reference audio failed (${response.status}).`);
  }
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch {
    return unavailable(timedOut() ? "Azure reference audio timed out." : "Azure returned unreadable reference audio.");
  }
  const audio = new Uint8Array(body);
  if (!audio.length) return unavailable("Azure returned empty reference audio.");
  if (audio.length > MAX_REFERENCE_AUDIO_BYTES) return unavailable("Azure returned too much reference audio.");
  return { status: "ok", audio };
}

async function requestAzureAudio(request: AzureRequest): Promise<AzureResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await request.fetch(request.endpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": request.subscriptionKey,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": REFERENCE_OUTPUT_FORMAT,
        "User-Agent": "learnharness-language-coach",
        Accept: AUDIO_CONTENT_TYPE,
      },
      body: request.ssml,
      signal: controller.signal,
    }).catch(() => null);
    if (!response) return unavailable(timedOut ? "Azure reference audio timed out." : "Azure reference audio could not be reached.");
    return readAudioResponse(response, () => timedOut);
  } finally {
    clearTimeout(timer);
  }
}

function ok(audio: Uint8Array, voice: string, cached: boolean, contentType = AUDIO_CONTENT_TYPE): ReferenceAudioOk {
  return { status: "ok", audioBase64: Buffer.from(audio).toString("base64"), contentType, voice, cached };
}

/** Synthesize from dictionary-forced SSML, reusing the plugin-data cache when the same phrase was played. */
export async function synthesizeReference(options: ReferenceTtsOptions): Promise<ReferenceAudioResult> {
  const subscriptionKey = options.subscriptionKey.trim();
  const region = options.region.trim();
  if (!subscriptionKey) return unavailable(MISSING_KEY);
  if (!region) return unavailable(MISSING_REGION);
  const pronunciation = pronunciationFor(options.text, options.locale);
  if (pronunciation.status !== "ok") return unavailable(pronunciation.reason);

  const key = referenceAudioKey({ voice: options.voice, text: options.text, pronunciation: pronunciation.value });
  const cached = readCachedReferenceAudio(options.cacheDirectory, key);
  if (cached) return ok(cached.audio, options.voice, true, cached.contentType);

  const audio = await requestAzureAudio({
    endpoint: endpointFor(region, options.endpointBase),
    subscriptionKey,
    ssml: ssmlFor(pronunciation, options.locale, options.voice),
    timeoutMs: options.timeoutMs ?? REFERENCE_TTS_TIMEOUT_MS,
    fetch: options.fetch ?? fetch,
  });
  if (audio.status !== "ok") return audio;
  try {
    writeCachedReferenceAudio({
      directory: options.cacheDirectory,
      key,
      audio: audio.audio,
      contentType: AUDIO_CONTENT_TYPE,
      maxEntries: options.maxCacheEntries,
    });
  } catch {
    // Playback is still useful when the cache directory is unavailable.
  }
  return ok(audio.audio, options.voice, false);
}
