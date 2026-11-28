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
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer, type StubServer } from "./support/http-stub.ts";

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

type BackendHosts = { azure?: string; tonePerfect?: string };

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
    targetLanguage: "en-US",
    firstLanguage: "zh",
  } satisfies Record<string, unknown>);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")) as { azureSpeechKey?: string };
  assert.equal(disk.azureSpeechKey, secret);

  const read = await call("get-settings");
  assert.deepEqual(read, { configured: true, region: "westus", tonePerfectConfigured: false });
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
  assert.deepEqual(read, { configured: false, region: "", tonePerfectConfigured: true });
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
