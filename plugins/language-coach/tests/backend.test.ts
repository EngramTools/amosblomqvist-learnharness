import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate, type LanguageCoachBackendOptions } from "../src/backend.ts";
import type { AssessmentOk, AssessmentResult, CoachLocale } from "../src/judge-types.ts";
import { SPEECH_KEY_MAX_LENGTH, TONEPERFECT_KEY_MAX_LENGTH } from "../src/settings-store.ts";
import { DEFAULT_EN_VOICE, DEFAULT_ZH_VOICE } from "../src/voice-config.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer, type StubRequest, type StubServer } from "./support/http-stub.ts";

const temporaryDirectories: string[] = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

const COMPLETE_ASSESSMENT = { RecognitionStatus: "Success", NBest: [{ AccuracyScore: 80, FluencyScore: 80, CompletenessScore: 90, Words: [] }] };
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

function readTonePerfectFixture(): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixtures", "toneperfect-zh-cn.json"), "utf8"));
}

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "language-coach-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

type BackendHosts = { azure?: string; tonePerfect?: string; referenceTts?: string; maxCacheEntries?: number };

type Backend = {
  call: (name: string, input?: unknown) => Promise<unknown>;
  cleanup: () => void;
};

function backendFixture(dataDirectory: string, hosts: BackendHosts = {}) {
  const handlers = new Map<string, (input: unknown) => unknown | Promise<unknown>>();
  const ctx = {
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as PluginBackendContext;
  const runtime: LanguageCoachBackendOptions = {};
  if (hosts.azure) runtime.judge = { endpointBase: hosts.azure };
  if (hosts.tonePerfect) runtime.tonePerfectJudge = { endpointBase: hosts.tonePerfect };
  if (hosts.referenceTts) {
    runtime.referenceTts = { endpointBase: hosts.referenceTts, maxCacheEntries: hosts.maxCacheEntries };
  }
  const cleanup = activate(ctx, runtime);
  const call = async (name: string, input?: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing handler ${name}`);
    return handler(input);
  };
  return { call, cleanup };
}

/** A backend with Azure credentials already saved. */
async function configuredBackend(hosts: BackendHosts = {}) {
  const backend = backendFixture(tempDirectory(), hosts);
  await backend.call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
  return backend;
}

function assessInput(samples: number, referenceText = "hello", locale: CoachLocale = "en-US") {
  const wav = encodeWav16kMono(new Float32Array(samples), 16_000);
  return { wavBase64: Buffer.from(wav).toString("base64"), referenceText, locale };
}

function assertOk(result: AssessmentResult): AssessmentOk {
  assert.equal(result.status, "ok");
  return result as AssessmentOk;
}

/** Runs `body` against a configured backend whose Azure judge talks to a stub answering `answer`. */
async function withAzureStub(answer: unknown, body: (backend: Backend, requests: unknown[]) => Promise<void>) {
  const stub = await stubSpeechServer((_request, response) => sendJson(response, 200, answer));
  try {
    const backend = await configuredBackend({ azure: stub.host });
    await body(backend, stub.requests);
    backend.cleanup();
  } finally {
    await stub.close();
  }
}

type ProviderStubs = { azure: StubServer; tonePerfect: StubServer };

/** A backend wired to one Azure stub and one TonePerfect stub, both answering 200. */
async function withProviderStubs(body: (backend: Backend, stubs: ProviderStubs) => Promise<void>) {
  const azure = await stubSpeechServer((_request, response) => sendJson(response, 200, COMPLETE_ASSESSMENT));
  const tonePerfect = await stubSpeechServer((_request, response) => sendJson(response, 200, readTonePerfectFixture()));
  const backend = backendFixture(tempDirectory(), { azure: azure.host, tonePerfect: tonePerfect.host });
  try {
    await body(backend, { azure, tonePerfect });
  } finally {
    backend.cleanup();
    await Promise.all([azure.close(), tonePerfect.close()]);
  }
}

const REFERENCE_AUDIO = Buffer.from("ID3-reference-audio");

type ReferenceStubOptions = { status?: number; maxCacheEntries?: number };

/** Runs `body` against a backend whose Azure TTS endpoint is a stub. */
async function withReferenceTts(
  body: (backend: Backend, requests: StubRequest[], directory: string) => Promise<void>,
  options: ReferenceStubOptions = {},
) {
  const status = options.status ?? 200;
  const stub = await stubSpeechServer((_request, response) => {
    response.writeHead(status, { "content-type": "audio/mpeg" });
    response.end(status < 300 ? REFERENCE_AUDIO : "unavailable");
  });
  const directory = tempDirectory();
  const backend = backendFixture(directory, { referenceTts: stub.host, maxCacheEntries: options.maxCacheEntries });
  try {
    await body(backend, stub.requests, directory);
  } finally {
    backend.cleanup();
    await stub.close();
  }
}

type ReferenceReply = {
  status: string;
  cached?: boolean;
  audioBase64?: string;
  contentType?: string;
  voice?: string;
  reason?: string;
};

test("settings storage never returns the Azure key to callers", async () => {
  const directory = tempDirectory();
  const secret = "[REDACTED:credential-assignment]";
  const { call, cleanup } = backendFixture(directory);
  const saved = await call("save-settings", {
    key: `  ${secret}  `,
    region: "westus",
    targetLanguage: "en-US",
    firstLanguage: "zh",
  });
  assert.deepEqual(saved, {
    configured: true,
    region: "westus",
    tonePerfectConfigured: false,
    enVoice: DEFAULT_EN_VOICE,
    zhVoice: DEFAULT_ZH_VOICE,
    targetLanguage: "en-US",
    firstLanguage: "zh",
  } satisfies Record<string, unknown>);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")) as { azureSpeechKey?: string };
  assert.equal(disk.azureSpeechKey, secret);

  const read = await call("get-settings");
  assert.deepEqual(read, {
    configured: true,
    region: "westus",
    tonePerfectConfigured: false,
    enVoice: DEFAULT_EN_VOICE,
    zhVoice: DEFAULT_ZH_VOICE,
  });
  assert.equal(JSON.stringify(read).includes(secret), false);
  assert.deepEqual(await call("get-coach-profile"), { targetLanguage: "en-US", firstLanguage: "zh" });
  cleanup();
});

test("save-settings rejects a blank key and a key over the length cap, and keeps one at the cap", async () => {
  const { call, cleanup } = backendFixture(tempDirectory());
  await assert.rejects(() => call("save-settings", { key: "   " }), /must not be blank/);
  await assert.rejects(() => call("save-settings", { key: "k".repeat(SPEECH_KEY_MAX_LENGTH + 1) }), /too long/);
  assert.equal(SPEECH_KEY_MAX_LENGTH, 4096);
  assert.deepEqual(await call("save-settings", { key: "k".repeat(SPEECH_KEY_MAX_LENGTH) }), {
    configured: true,
    region: "",
    tonePerfectConfigured: false,
    enVoice: DEFAULT_EN_VOICE,
    zhVoice: DEFAULT_ZH_VOICE,
    targetLanguage: "en-US",
    firstLanguage: "en",
  });
  cleanup();
});

test("assess-pronunciation routes through the registered backend handler", async () => {
  await withAzureStub({
    NBest: [{
      PronunciationAssessment: { AccuracyScore: 77, FluencyScore: 80, CompletenessScore: 90, ProsodyScore: 65 },
      Words: [{ Word: "hello", PronunciationAssessment: { AccuracyScore: 77 }, Phonemes: [] }],
    }],
  }, async ({ call }, requests) => {
    const result = (await call("assess-pronunciation", assessInput(800))) as AssessmentResult;
    assert.equal(result.status, "ok");
    assert.equal(requests.length, 1);
  });
});

test("assess-pronunciation rejects a clip longer than the recording limit", async () => {
  const { call, cleanup } = await configuredBackend();
  const oversized = Buffer.alloc(1_000_000).toString("base64");
  await assert.rejects(
    () => call("assess-pronunciation", { wavBase64: oversized, referenceText: "hello", locale: "en-US" }),
    /longer than the 30-second limit/,
  );
  cleanup();
});

test("assess-pronunciation accepts a full clip that captured one extra capture quantum", async () => {
  await withAzureStub(COMPLETE_ASSESSMENT, async ({ call }, requests) => {
    const result = (await call("assess-pronunciation", assessInput(480_000 + 4096))) as AssessmentResult;
    assert.equal(result.status, "ok");
    assert.equal(requests.length, 1);
  });
});

test("assess-pronunciation rejects an over-long reference text before contacting Azure", async () => {
  await withAzureStub(COMPLETE_ASSESSMENT, async ({ call }, requests) => {
    await assert.rejects(() => call("assess-pronunciation", assessInput(800, "hello ".repeat(500))), /reference text/i);
    assert.equal(requests.length, 0);
  });
});

test("with both keys set, zh-CN assesses through TonePerfect and en-US through Azure", async () => {
  await withProviderStubs(async (backend, { azure, tonePerfect }) => {
    await backend.call("save-settings", {
      key: "azure-key",
      region: "westus",
      tonePerfectKey: "toneperfect-key",
      targetLanguage: "zh-CN",
      firstLanguage: "en",
    });

    const zh = assertOk(await backend.call("assess-pronunciation", assessInput(800, "你好", "zh-CN")) as AssessmentResult);
    assert.equal(zh.syllables?.[0]?.syllable, "你");
    assert.equal(zh.syllables?.[0]?.initial?.decision, "uncertain");
    assert.equal(tonePerfect.requests.length, 1);
    assert.equal(azure.requests.length, 0);
    assert.equal(tonePerfect.requests[0]?.headers.authorization, "Bearer toneperfect-key");

    const en = assertOk(await backend.call("assess-pronunciation", assessInput(800, "hello", "en-US")) as AssessmentResult);
    assert.equal(en.status, "ok");
    assert.equal(azure.requests.length, 1);
    assert.equal(tonePerfect.requests.length, 1);
    assert.equal(azure.requests[0]?.headers["ocp-apim-subscription-key"], "azure-key");
  });
});

test("with only the Azure key set, zh-CN still assesses through Azure", async () => {
  await withProviderStubs(async (backend, { azure, tonePerfect }) => {
    await backend.call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "zh-CN", firstLanguage: "en" });
    const result = assertOk(await backend.call("assess-pronunciation", assessInput(800, "你好", "zh-CN")) as AssessmentResult);
    assert.equal(result.status, "ok");
    assert.equal(azure.requests.length, 1);
    assert.equal(tonePerfect.requests.length, 0);
  });
});

test("the TonePerfect key is stored backend-only and settings report only whether it is configured", async () => {
  const directory = tempDirectory();
  const secret = "toneperfect-secret";
  const { call, cleanup } = backendFixture(directory);
  const saved = await call("save-settings", { tonePerfectKey: `  ${secret}  ` }) as Record<string, unknown>;
  assert.equal(saved.tonePerfectConfigured, true);
  assert.equal(JSON.stringify(saved).includes(secret), false);

  const read = await call("get-settings");
  assert.deepEqual(read, {
    configured: false,
    region: "",
    tonePerfectConfigured: true,
    enVoice: DEFAULT_EN_VOICE,
    zhVoice: DEFAULT_ZH_VOICE,
  });
  assert.equal(JSON.stringify(read).includes(secret), false);

  const disk = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")) as { tonePerfectKey?: string };
  assert.equal(disk.tonePerfectKey, secret);
  cleanup();
});

test("save-settings validates the TonePerfect key with the Azure key rules", async () => {
  const { call, cleanup } = backendFixture(tempDirectory());
  await assert.rejects(() => call("save-settings", { tonePerfectKey: "   " }), /must not be blank/);
  await assert.rejects(
    () => call("save-settings", { tonePerfectKey: "k".repeat(TONEPERFECT_KEY_MAX_LENGTH + 1) }),
    /too long/,
  );
  const saved = await call("save-settings", { tonePerfectKey: "k".repeat(TONEPERFECT_KEY_MAX_LENGTH) }) as Record<string, unknown>;
  assert.equal(saved.tonePerfectConfigured, true);
  cleanup();
});

test("zh-CN reference audio sends sapi pinyin SSML with the configured voice and then serves the cache", async () => {
  await withReferenceTts(async (backend, requests) => {
    await backend.call("save-settings", {
      key: "azure-key",
      region: "westus",
      targetLanguage: "zh-CN",
      zhVoice: "zh-CN-YunxiNeural",
    });
    const input = { text: "你好", locale: "zh-CN" as const };

    const first = await backend.call("get-reference-audio", input) as ReferenceReply;
    assert.equal(first.status, "ok");
    assert.equal(first.cached, false);
    assert.equal(first.voice, "zh-CN-YunxiNeural");
    assert.equal(first.contentType, "audio/mpeg");
    assert.deepEqual(Buffer.from(first.audioBase64 ?? "", "base64"), REFERENCE_AUDIO);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path, "/cognitiveservices/v1");
    assert.equal(requests[0]?.headers["ocp-apim-subscription-key"], "azure-key");
    const ssml = requests[0]?.body.toString("utf8") ?? "";
    assert.match(ssml, /<phoneme alphabet="sapi" ph="ni 3 hao 3">/);
    assert.match(ssml, /<voice name="zh-CN-YunxiNeural">/);

    const second = await backend.call("get-reference-audio", input) as ReferenceReply;
    assert.equal(second.status, "ok");
    assert.equal(second.cached, true);
    assert.deepEqual(Buffer.from(second.audioBase64 ?? "", "base64"), REFERENCE_AUDIO);
    assert.equal(requests.length, 1);
  });
});

test("en-US reference audio uses the CMUdict IPA in SSML and a configured voice", async () => {
  await withReferenceTts(async (backend, requests) => {
    await backend.call("save-settings", {
      key: "azure-key",
      region: "westus",
      targetLanguage: "en-US",
      enVoice: "en-US-GuyNeural",
    });
    const result = await backend.call("get-reference-audio", { text: "think", locale: "en-US" }) as ReferenceReply;
    assert.equal(result.status, "ok");
    assert.equal(result.voice, "en-US-GuyNeural");
    const ssml = requests[0]?.body.toString("utf8") ?? "";
    assert.match(ssml, /<phoneme alphabet="ipa" ph="θɪŋk">think<\/phoneme>/);
    assert.match(ssml, /<voice name="en-US-GuyNeural">/);
  });
});

test("the reference audio cache is bounded and evicts the oldest entry first", async () => {
  await withReferenceTts(async (backend, requests, directory) => {
    await backend.call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "zh-CN" });
    for (const text of ["你好", "再见", "谢谢"]) {
      const result = await backend.call("get-reference-audio", { text, locale: "zh-CN" }) as ReferenceReply;
      assert.equal(result.status, "ok");
    }
    assert.equal(requests.length, 3);
    const cacheDirectory = path.join(directory, "reference-audio");
    assert.equal(fs.readdirSync(cacheDirectory).filter(name => name.endsWith(".mp3")).length, 2);

    const evicted = await backend.call("get-reference-audio", { text: "你好", locale: "zh-CN" }) as ReferenceReply;
    assert.equal(evicted.status, "ok");
    assert.equal(evicted.cached, false);
    assert.equal(requests.length, 4);
  }, { maxCacheEntries: 2 });
});

test("reference audio reports missing credentials and a TTS failure as unavailable, without caching", async () => {
  await withReferenceTts(async (backend, requests) => {
    const missing = await backend.call("get-reference-audio", { text: "hello", locale: "en-US" }) as ReferenceReply;
    assert.equal(missing.status, "unavailable");
    assert.match(missing.reason ?? "", /Azure Speech key/);
    assert.equal(requests.length, 0);

    await backend.call("save-settings", { key: "azure-key", region: "westus" });
    const unknown = await backend.call("get-reference-audio", { text: "zzzz", locale: "en-US" }) as ReferenceReply;
    assert.equal(unknown.status, "unavailable");
    assert.match(unknown.reason ?? "", /No CMUdict pronunciation/);
    assert.equal(requests.length, 0);

    const failed = await backend.call("get-reference-audio", { text: "hello", locale: "en-US" }) as ReferenceReply;
    assert.equal(failed.status, "unavailable");
    assert.match(failed.reason ?? "", /failed \(503\)/);
    assert.equal(requests.length, 1);
  }, { status: 503 });
});

test("reference voices default per language and are validated in settings", async () => {
  const { call, cleanup } = backendFixture(tempDirectory());
  assert.deepEqual(await call("get-settings"), {
    configured: false,
    region: "",
    tonePerfectConfigured: false,
    enVoice: DEFAULT_EN_VOICE,
    zhVoice: DEFAULT_ZH_VOICE,
  });

  const saved = await call("save-settings", {
    enVoice: "  en-US-GuyNeural  ",
    zhVoice: "zh-CN-YunxiNeural",
  }) as Record<string, unknown>;
  assert.equal(saved.enVoice, "en-US-GuyNeural");
  assert.equal(saved.zhVoice, "zh-CN-YunxiNeural");

  await assert.rejects(
    () => call("save-settings", { enVoice: "zh-CN-XiaoxiaoNeural" }),
    /Azure en-US neural voice/,
  );
  await assert.rejects(
    () => call("save-settings", { zhVoice: "en-US-JennyNeural" }),
    /Azure zh-CN neural voice/,
  );
  const reset = await call("save-settings", { enVoice: "   " }) as Record<string, unknown>;
  assert.equal(reset.enVoice, DEFAULT_EN_VOICE);
  cleanup();
});

test("reference dictionary ignores inherited object properties", async () => {
  const { pronunciationFor } = await import("../src/pronunciation.ts");
  const prototype = Object.prototype;
  Object.defineProperty(prototype, "valueof", { value: () => "inherited", configurable: true });
  try {
    assert.deepEqual(pronunciationFor("valueOf", "en-US"), {
      status: "unavailable", reason: 'No CMUdict pronunciation for "valueOf".',
    });
    assert.equal(pronunciationFor("constructor", "en-US").status, "ok");
  } finally {
    Reflect.deleteProperty(prototype, "valueof");
  }
});

test("reference TTS rejects unsafe regions before sending credentials", async () => {
  const { synthesizeReference } = await import("../src/reference-tts.ts");
  for (const region of ["evil.example/x#", "west/us", "west#us", "west@us", "WestUS"]) {
    let calls = 0;
    const result = await synthesizeReference({
      subscriptionKey: "secret", region, voice: DEFAULT_EN_VOICE, text: "hello",
      locale: "en-US", cacheDirectory: tempDirectory(),
      fetch: async () => { calls++; return new Response("audio"); },
    });
    assert.equal(result.status, "unavailable");
    assert.equal(calls, 0);
  }
});

test("reference TTS timeout covers a stalled response body", async () => {
  const { synthesizeReference } = await import("../src/reference-tts.ts");
  const result = await synthesizeReference({
    subscriptionKey: "secret", region: "westus", voice: DEFAULT_EN_VOICE, text: "hello",
    locale: "en-US", cacheDirectory: tempDirectory(), timeoutMs: 10,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        const fallback = setTimeout(() => controller.error(new Error("body stalled")), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          controller.error(new Error("aborted"));
        }, { once: true });
      },
    })),
  });
  assert.deepEqual(result, { status: "unavailable", reason: "Azure reference audio timed out." });
});
