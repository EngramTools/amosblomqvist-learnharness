import type { AssessmentResult, CoachLocale, PronunciationJudge } from "./judge-types.ts";
import { mapAzurePronunciationResponse } from "./azure-mapper.ts";
import { buildPronunciationAssessmentHeader } from "./pronunciation-header.ts";

/** One short clip per assessment; stall must not hold the UI open. */
export const AZURE_ASSESS_TIMEOUT_MS = 15_000;

export type AzureJudgeOptions = {
  subscriptionKey: string;
  region: string;
  endpointBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type AzureJudgeRuntime = Pick<AzureJudgeOptions, "endpointBase" | "timeoutMs" | "fetch">;

function speechEndpoint(region: string, locale: CoachLocale, base?: string): string {
  const host = base ?? `https://${region}.stt.speech.microsoft.com`;
  return `${host}/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`;
}

function unavailable(reason: string): AssessmentResult {
  return { status: "unavailable", reason };
}

async function discardBody(response: Response): Promise<void> {
  try { await response.arrayBuffer(); } catch { /* connection cleanup best-effort */ }
}

export function createAzureJudge(options: AzureJudgeOptions): PronunciationJudge {
  const timeoutMs = options.timeoutMs ?? AZURE_ASSESS_TIMEOUT_MS;
  const http = options.fetch ?? fetch;
  return {
    async assess(clip, referenceText, locale) {
      const key = options.subscriptionKey.trim();
      const region = options.region.trim();
      if (!key) return unavailable("Add an Azure Speech key in Language coach settings.");
      if (!region) return unavailable("Add an Azure Speech region in Language coach settings.");
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await http(speechEndpoint(region, locale, options.endpointBase), {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            Accept: "application/json",
            "Pronunciation-Assessment": buildPronunciationAssessmentHeader(referenceText, locale),
          },
          body: new Blob([Uint8Array.from(clip)]),
          signal: controller.signal,
        }).catch(() => null);
        if (!response) {
          return unavailable(timedOut ? "Azure pronunciation assessment timed out." : "Azure pronunciation assessment could not be reached.");
        }
        if (!response.ok) {
          await discardBody(response);
          return unavailable(`Azure pronunciation assessment failed (${response.status}).`);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return unavailable(timedOut ? "Azure pronunciation assessment timed out." : "Azure returned an unreadable pronunciation payload.");
        }
        try {
          return mapAzurePronunciationResponse(body, locale);
        } catch {
          return unavailable("Azure returned an unexpected pronunciation payload.");
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Direct entry for tests and callers that already hold credentials. */
export async function assess(
  clip: Uint8Array,
  referenceText: string,
  locale: CoachLocale,
  options: AzureJudgeOptions,
): Promise<AssessmentResult> {
  return createAzureJudge(options).assess(clip, referenceText, locale);
}