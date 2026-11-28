import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assess } from "../src/toneperfect-judge.ts";
import type { AssessmentOk, AssessmentResult } from "../src/judge-types.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer, type StubRequest, type StubServer } from "./support/http-stub.ts";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const TIMED_OUT = "TonePerfect pronunciation assessment timed out.";

type Responder = (request: StubRequest, response: ServerResponse) => void;

const stubs: StubServer[] = [];
after(async () => { for (const stub of stubs) await stub.close(); });

function readFixture(): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixtures", "toneperfect-zh-cn.json"), "utf8"));
}

function assertOk(result: AssessmentResult): AssessmentOk {
  assert.ok(result.status === "ok");
  return result;
}

function assertUnavailable(result: AssessmentResult, reason: string | RegExp): void {
  assert.ok(result.status === "unavailable");
  if (typeof reason === "string") assert.equal(result.reason, reason);
  else assert.match(result.reason, reason);
}

/** Runs one assessment against a throwaway TonePerfect stub answering with `respond`. */
async function assessVia(respond: Responder, timeoutMs?: number): Promise<{ result: AssessmentResult; requests: StubRequest[]; clip: Uint8Array }> {
  const stub = await stubSpeechServer(respond);
  stubs.push(stub);
  const clip = encodeWav16kMono(new Float32Array(1600), 16_000);
  const result = await assess(clip, "你好", "zh-CN", {
    apiKey: "tp-key",
    endpointBase: stub.host,
    timeoutMs,
  });
  return { result, requests: stub.requests, clip };
}

/** Rebuild the multipart body the stub received so its parts can be asserted. */
async function multipartForm(request: StubRequest): Promise<FormData> {
  const contentType = request.headers["content-type"];
  assert.ok(typeof contentType === "string");
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  return new Response(new Uint8Array(request.body), { headers: { "content-type": contentType } }).formData();
}

function idempotencyKey(request: StubRequest): string {
  const key = request.headers["idempotency-key"];
  assert.ok(typeof key === "string");
  return key;
}

test("assess sends the clip and reference as multipart to TonePerfect with a fresh idempotency key", async () => {
  const { result, requests, clip } = await assessVia((_request, response) => sendJson(response, 200, readFixture()));
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/assess");
  assert.equal(request.headers.authorization, "Bearer tp-key");
  assert.match(idempotencyKey(request), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const form = await multipartForm(request);
  assert.equal(form.get("text"), "你好");
  assert.equal(form.get("language"), "zh-CN");
  const audio = form.get("audio");
  assert.ok(audio instanceof Blob);
  assert.equal(audio.type, "audio/wav");
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), clip);

  const ok = assertOk(result);
  assert.deepEqual(ok.words, [{ word: "你", score: 65.6 }, { word: "好", score: 83 }]);
});

test("the live 你好 fixture maps each syllable initial, final and tone with its decision", async () => {
  const { result } = await assessVia((_request, response) => sendJson(response, 200, readFixture()));
  const ok = assertOk(result);
  assert.deepEqual(ok.syllables, [
    {
      syllable: "你",
      pinyin: "ni3",
      score: 65.6,
      initial: { expected: "n", heard: "l", score: 65.6, decision: "uncertain" },
      final: { expected: "i", heard: "i", score: 94.2, decision: "no_correction" },
      tone: { expected: 3, heard: 3, score: 92.8, decision: "no_correction" },
    },
    {
      syllable: "好",
      pinyin: "hao3",
      score: 83,
      initial: { expected: "h", heard: "h", score: 83, decision: "no_correction" },
      final: { expected: "ao", heard: "ao", score: 92.3, decision: "no_correction" },
      tone: { expected: 3, heard: 3, score: 95.2, decision: "no_correction" },
    },
  ]);
  assert.equal(ok.scores.accuracy, 74.6);
  assert.equal(ok.scores.completeness, 100);
  assert.equal(ok.scores.fluency, undefined);
});

test("each attempt sends a different Idempotency-Key", async () => {
  const keys: string[] = [];
  const respond: Responder = (request, response) => {
    keys.push(idempotencyKey(request));
    sendJson(response, 200, readFixture());
  };
  await assessVia(respond);
  await assessVia(respond);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("an unassessable recording is unavailable with the provider's reason", async () => {
  const { result } = await assessVia((_request, response) => sendJson(response, 200, {
    assessable: false,
    reason: "no_speech / no_audio",
    scores: null,
    words: [],
  }));
  assertUnavailable(result, /no_speech \/ no_audio/);
});

const ERROR_RESPONSES: [number, string][] = [
  [401, "invalid_api_key"],
  [402, "insufficient_credits"],
  [429, "rate_limit"],
  [503, "engine_unavailable"],
];

for (const [status, code] of ERROR_RESPONSES) {
  test(`a ${status} ${code} response is unavailable with a readable reason`, async () => {
    const { result } = await assessVia((_request, response) => sendJson(response, status, {
      error: { code, message: "The request could not be processed." },
    }));
    assertUnavailable(result, new RegExp(`${status}.*${code}`));
  });
}

test("a TonePerfect timeout is unavailable with a readable reason", async () => {
  const { result } = await assessVia(() => {}, 25);
  assertUnavailable(result, TIMED_OUT);
});

test("an unreadable TonePerfect body is unavailable, never a zero score", async () => {
  const { result } = await assessVia((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{ not json");
  });
  assertUnavailable(result, /unreadable pronunciation payload/i);
});

test("a word without a score is unavailable, never a zero", async () => {
  const { result } = await assessVia((_request, response) => sendJson(response, 200, {
    assessable: true,
    scores: { pronunciation: 70, integrity: 100 },
    words: [{ word: "你", pinyin: "ni3", score: null, phones: [] }],
  }));
  assertUnavailable(result, /unexpected pronunciation payload/i);
});

test("the provider decision is mapped as-is even when the raw score is low", async () => {
  const { result } = await assessVia((_request, response) => sendJson(response, 200, {
    assessable: true,
    scores: { pronunciation: 10, integrity: 100 },
    words: [{
      word: "你",
      pinyin: "ni3",
      score: 10,
      phones: [{ dimension: "initial", expected: "n", heard: "n", score: 10, decision: "no_correction" }],
    }],
  }));
  const ok = assertOk(result);
  assert.equal(ok.syllables?.[0]?.initial?.score, 10);
  assert.equal(ok.syllables?.[0]?.initial?.decision, "no_correction");
});
