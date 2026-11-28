import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assess } from "../src/azure-judge.ts";
import { buildPronunciationAssessmentHeader } from "../src/pronunciation-header.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer } from "./support/http-stub.ts";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

function sampleClip(): Uint8Array {
  return encodeWav16kMono(new Float32Array(1600), 16_000);
}

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixtures", name), "utf8"));
}

/** Azure expects the Pronunciation-Assessment header as Base64-encoded JSON. */
function parseHeader(requestHeaders: IncomingHttpHeaders): Record<string, unknown> {
  const raw = requestHeaders["pronunciation-assessment"];
  assert.ok(typeof raw === "string");
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
}

function isPcmWav(body: Buffer): boolean {
  return body.length >= 44 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WAVE";
}

const stubs: Stub[] = [];
after(async () => { for (const stub of stubs) await stub.close(); });

type Stub = Awaited<ReturnType<typeof stubSpeechServer>>;

test("assess sends 16 kHz mono PCM WAV with scripted pronunciation headers for en-US", async () => {
  const fixture = readFixture("azure-en-us.json");
  const stub = await stubSpeechServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.match(request.path ?? "", /language=en-US/);
    assert.equal(request.headers["content-type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
    assert.ok(isPcmWav(request.body));
    const header = parseHeader(request.headers);
    assert.equal(header.ReferenceText, "think");
    assert.equal(header.PhonemeAlphabet, "IPA");
    assert.equal(header.NBestPhonemeCount, 5);
    assert.equal(header.EnableProsodyAssessment, true);
    sendJson(response, 200, fixture);
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "think", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: stub.host,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.words, [{ word: "think", score: 70 }]);
  assert.equal(result.phonemes?.length, 2);
  assert.deepEqual(result.phonemes?.[0], { phoneme: "θ", score: 42, heard: ["s", "θ", "f", "t", "ð"] });
  assert.equal(result.scores.accuracy, 88);
  assert.equal(result.scores.prosody, 72);
});

test("assess omits prosody and maps zh-CN syllables with pinyin", async () => {
  const fixture = readFixture("azure-zh-cn.json");
  const stub = await stubSpeechServer((request, response) => {
    const header = parseHeader(request.headers);
    assert.equal(header.EnableProsodyAssessment, undefined);
    sendJson(response, 200, fixture);
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "你好", "zh-CN", {
    subscriptionKey: "azure-key",
    region: "eastasia",
    endpointBase: stub.host,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.syllables, [
    { syllable: "ni3", pinyin: "nǐ", score: 78 },
    { syllable: "hao3", pinyin: "hǎo", score: 84 },
  ]);
  assert.equal(result.phonemes, undefined);
  assert.equal(result.scores.prosody, undefined);
});

test("assess returns unavailable without a key", async () => {
  const result = await assess(sampleClip(), "hello", "en-US", { subscriptionKey: "", region: "westus" });
  assert.deepEqual(result, { status: "unavailable", reason: "Add an Azure Speech key in Language coach settings." });
});

test("assess returns unavailable on Azure HTTP errors and timeouts", async () => {
  const errorStub = await stubSpeechServer((_request, response) => sendJson(response, 503, { error: "busy" }));
  stubs.push(errorStub);
  const errorResult = await assess(sampleClip(), "hello", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: errorStub.host,
  });
  assert.equal(errorResult.status, "unavailable");
  if (errorResult.status === "unavailable") assert.match(errorResult.reason, /503/);

  const hangStub = await stubSpeechServer(() => {});
  stubs.push(hangStub);
  const timeoutResult = await assess(sampleClip(), "hello", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: hangStub.host,
    timeoutMs: 25,
  });
  assert.deepEqual(timeoutResult, { status: "unavailable", reason: "Azure pronunciation assessment timed out." });
});

test("assess returns unavailable when Azure sends an unreadable body", async () => {
  const stub = await stubSpeechServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{ not json");
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "hello", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: stub.host,
  });
  assert.equal(result.status, "unavailable");
});

test("assess returns unavailable when the response body times out", async () => {
  const stub = await stubSpeechServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"NBest\":");
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "hello", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: stub.host,
    timeoutMs: 50,
  });
  assert.deepEqual(result, { status: "unavailable", reason: "Azure pronunciation assessment timed out." });
});

test("the pronunciation header is Base64-encoded JSON that keeps non-ASCII reference text", () => {
  const header = buildPronunciationAssessmentHeader("你好 😀", "zh-CN");
  assert.match(header, /^[A-Za-z0-9+/]+={0,2}$/);
  const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { ReferenceText: string };
  assert.equal(parsed.ReferenceText, "你好 😀");
});

// Azure's REST endpoint reports the scores flat on the best entry and its words; the Speech SDK nests
// them under PronunciationAssessment, which is the shape the fixtures above still use.
test("the REST response shape maps the scores Azure returns on the best entry and its words", async () => {
  const stub = await stubSpeechServer((_request, response) => {
    sendJson(response, 200, {
      RecognitionStatus: "Success",
      NBest: [{
        AccuracyScore: 88,
        FluencyScore: 90,
        CompletenessScore: 95,
        ProsodyScore: 72,
        Words: [{
          Word: "think",
          AccuracyScore: 70,
          Phonemes: [{
            Phoneme: "θ",
            AccuracyScore: 42,
            NBestPhonemes: [{ Phoneme: "s" }, { Phoneme: "θ" }],
          }],
        }],
      }],
    });
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "think", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: stub.host,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.scores.accuracy, 88);
  assert.equal(result.scores.fluency, 90);
  assert.equal(result.scores.completeness, 95);
  assert.equal(result.scores.prosody, 72);
  assert.deepEqual(result.words, [{ word: "think", score: 70 }]);
  assert.deepEqual(result.phonemes?.[0], { phoneme: "θ", score: 42, heard: ["s", "θ"] });
});

test("a NoMatch response is unavailable instead of a zero-score assessment", async () => {
  const stub = await stubSpeechServer((_request, response) => {
    sendJson(response, 200, { RecognitionStatus: "NoMatch", NBest: [{ Words: [] }] });
  });
  stubs.push(stub);

  const result = await assess(sampleClip(), "hello", "en-US", {
    subscriptionKey: "azure-key",
    region: "westus",
    endpointBase: stub.host,
  });
  assert.equal(result.status, "unavailable");
});