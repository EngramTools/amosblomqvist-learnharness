import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { AssessmentResult } from "../src/judge-types.ts";
import { SPEECH_KEY_MAX_LENGTH } from "../src/settings-store.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer } from "./support/http-stub.ts";

const temporaryDirectories: string[] = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

const COMPLETE_ASSESSMENT = { RecognitionStatus: "Success", NBest: [{ AccuracyScore: 80, FluencyScore: 80, CompletenessScore: 90, Words: [] }] };

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "language-coach-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

function backendFixture(dataDirectory: string, judgeHost?: string) {
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
  const cleanup = activate(ctx, judgeHost ? { judge: { endpointBase: judgeHost } } : {});
  const call = async (name: string, input?: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing handler ${name}`);
    return handler(input);
  };
  return { call, cleanup };
}

/** A backend with Azure credentials already saved. */
async function configuredBackend(judgeHost?: string) {
  const backend = backendFixture(tempDirectory(), judgeHost);
  await backend.call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
  return backend;
}

function assessInput(samples: number, referenceText = "hello") {
  const wav = encodeWav16kMono(new Float32Array(samples), 16_000);
  return { wavBase64: Buffer.from(wav).toString("base64"), referenceText, locale: "en-US" };
}

/** Runs `body` against a configured backend whose Azure judge talks to a stub answering `answer`. */
async function withAzureStub(answer: unknown, body: (backend: Awaited<ReturnType<typeof configuredBackend>>, requests: unknown[]) => Promise<void>) {
  const stub = await stubSpeechServer((_request, response) => sendJson(response, 200, answer));
  try {
    const backend = await configuredBackend(stub.host);
    await body(backend, stub.requests);
    backend.cleanup();
  } finally {
    await stub.close();
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
  assert.deepEqual(saved, { configured: true, region: "westus", targetLanguage: "en-US", firstLanguage: "zh" } satisfies Record<string, unknown>);
  const disk = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")) as { azureSpeechKey?: string };
  assert.equal(disk.azureSpeechKey, secret);

  const read = await call("get-settings");
  assert.deepEqual(read, { configured: true, region: "westus" });
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
