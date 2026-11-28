import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { AssessmentResult } from "../src/judge-types.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer } from "./support/http-stub.ts";

const temporaryDirectories: string[] = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

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

test("settings storage never returns the Azure key to callers", async () => {
  const directory = tempDirectory();
  const secret = "azure-secret-should-not-leak";
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

test("assess-pronunciation routes through the registered backend handler", async () => {
  const directory = tempDirectory();
  const stub = await stubSpeechServer((_request, response) => {
    sendJson(response, 200, {
      NBest: [{
        PronunciationAssessment: { AccuracyScore: 77, FluencyScore: 80, CompletenessScore: 90, ProsodyScore: 65 },
        Words: [{ Word: "hello", PronunciationAssessment: { AccuracyScore: 77 }, Phonemes: [] }],
      }],
    });
  });
  try {
    const { call, cleanup } = backendFixture(directory, stub.host);
    await call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
    const wav = encodeWav16kMono(new Float32Array(800), 16_000);
    const result = (await call("assess-pronunciation", {
      wavBase64: Buffer.from(wav).toString("base64"),
      referenceText: "hello",
      locale: "en-US",
    })) as AssessmentResult;
    assert.equal(result.status, "ok");
    assert.equal(stub.requests.length, 1);
    cleanup();
  } finally {
    await stub.close();
  }
});

test("assess-pronunciation rejects a clip longer than the recording limit", async () => {
  const directory = tempDirectory();
  const { call, cleanup } = backendFixture(directory);
  await call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
  const oversized = Buffer.alloc(1_000_000).toString("base64");
  await assert.rejects(
    () => call("assess-pronunciation", { wavBase64: oversized, referenceText: "hello", locale: "en-US" }),
    /longer than the 30-second limit/,
  );
  cleanup();
});

test("assess-pronunciation accepts a full clip that captured one extra capture quantum", async () => {
  const directory = tempDirectory();
  const stub = await stubSpeechServer((_request, response) => {
    sendJson(response, 200, { RecognitionStatus: "Success", NBest: [{ AccuracyScore: 80, Words: [] }] });
  });
  try {
    const { call, cleanup } = backendFixture(directory, stub.host);
    await call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
    const wav = encodeWav16kMono(new Float32Array(480_000 + 4096), 16_000);
    const result = (await call("assess-pronunciation", {
      wavBase64: Buffer.from(wav).toString("base64"),
      referenceText: "hello",
      locale: "en-US",
    })) as AssessmentResult;
    assert.equal(result.status, "ok");
    assert.equal(stub.requests.length, 1);
    cleanup();
  } finally {
    await stub.close();
  }
});

test("assess-pronunciation rejects an over-long reference text before contacting Azure", async () => {
  const directory = tempDirectory();
  const stub = await stubSpeechServer((_request, response) => {
    sendJson(response, 200, { RecognitionStatus: "Success", NBest: [{ Words: [] }] });
  });
  try {
    const { call, cleanup } = backendFixture(directory, stub.host);
    await call("save-settings", { key: "azure-key", region: "westus", targetLanguage: "en-US", firstLanguage: "en" });
    const wav = encodeWav16kMono(new Float32Array(800), 16_000);
    await assert.rejects(
      () => call("assess-pronunciation", {
        wavBase64: Buffer.from(wav).toString("base64"),
        referenceText: "hello ".repeat(500),
        locale: "en-US",
      }),
      /reference text/i,
    );
    assert.equal(stub.requests.length, 0);
    cleanup();
  } finally {
    await stub.close();
  }
});