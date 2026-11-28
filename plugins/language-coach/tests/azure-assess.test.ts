import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assess } from "../src/azure-judge.ts";
import type { AssessmentOk, AssessmentResult, CoachLocale } from "../src/judge-types.ts";
import { buildPronunciationAssessmentHeader } from "../src/pronunciation-header.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";
import { sendJson, stubSpeechServer, type StubRequest, type StubServer } from "./support/http-stub.ts";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const UNEXPECTED_PAYLOAD = "Azure returned an unexpected pronunciation payload.";

type Entry = Record<string, unknown>;
type Responder = (request: StubRequest, response: ServerResponse) => void;
type AssessOptions = { locale?: CoachLocale; referenceText?: string; timeoutMs?: number; region?: string };

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

const stubs: StubServer[] = [];
after(async () => { for (const stub of stubs) await stub.close(); });

const respondJson = (body: unknown): Responder => (_request, response) => sendJson(response, 200, body);

/** Runs one assessment against a throwaway Speech stub that answers with `respond`. */
async function assessVia(respond: Responder, options: AssessOptions = {}): Promise<AssessmentResult> {
  const stub = await stubSpeechServer(respond);
  stubs.push(stub);
  return assess(sampleClip(), options.referenceText ?? "hello", options.locale ?? "en-US", {
    subscriptionKey: "azure-key",
    region: options.region ?? "westus",
    endpointBase: stub.host,
    timeoutMs: options.timeoutMs,
  });
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

/** The REST shape: Azure reports the scores flat on the best entry and on its words and phonemes. */
function restBody(parts: { best?: Entry; word?: Entry; phoneme?: Entry } = {}): Entry {
  return {
    RecognitionStatus: "Success",
    NBest: [{
      AccuracyScore: 88,
      FluencyScore: 90,
      CompletenessScore: 95,
      ProsodyScore: 72,
      ...parts.best,
      Words: [{
        Word: "think",
        AccuracyScore: 70,
        ...parts.word,
        Phonemes: [{
          Phoneme: "θ",
          AccuracyScore: 42,
          NBestPhonemes: [{ Phoneme: "s" }, { Phoneme: "θ" }],
          ...parts.phoneme,
        }],
      }],
    }],
  };
}

test("assess sends 16 kHz mono PCM WAV with scripted pronunciation headers for en-US", async () => {
  const result = await assessVia((request, response) => {
    assert.equal(request.method, "POST");
    assert.match(request.path ?? "", /language=en-US/);
    assert.match(request.path ?? "", /&format=detailed$/);
    assert.equal(request.headers["ocp-apim-subscription-key"], "azure-key");
    assert.equal(request.headers["content-type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
    assert.ok(isPcmWav(request.body));
    assert.deepEqual(parseHeader(request.headers), {
      ReferenceText: "think",
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true,
      PhonemeAlphabet: "IPA",
      NBestPhonemeCount: 5,
      EnableProsodyAssessment: true,
    });
    sendJson(response, 200, readFixture("azure-en-us.json"));
  }, { referenceText: "think" });
  const ok = assertOk(result);
  assert.deepEqual(ok.words, [{ word: "think", score: 70, phonemes: [
    { phoneme: "θ", score: 42, heard: ["s", "θ", "f", "t", "ð"] },
    { phoneme: "ɪ", score: 90, heard: ["ɪ", "i", "ə", "e", "ɑ"] },
  ] }]);
  assert.equal(ok.phonemes?.length, 2);
  assert.deepEqual(ok.phonemes?.[0], { phoneme: "θ", score: 42, heard: ["s", "θ", "f", "t", "ð"] });
  assert.equal(ok.scores.accuracy, 88);
  assert.equal(ok.scores.prosody, 72);
});

test("assess omits prosody and maps zh-CN syllables with pinyin", async () => {
  const result = await assessVia((request, response) => {
    assert.equal(parseHeader(request.headers).EnableProsodyAssessment, undefined);
    sendJson(response, 200, readFixture("azure-zh-cn.json"));
  }, { locale: "zh-CN", referenceText: "你好", region: "eastasia" });
  const ok = assertOk(result);
  assert.deepEqual(ok.syllables, [
    { syllable: "ni3", pinyin: "nǐ", score: 78 },
    { syllable: "hao3", pinyin: "hǎo", score: 84 },
  ]);
  assert.equal(ok.phonemes, undefined);
  assert.equal(ok.scores.prosody, undefined);
});

test("assess posts the trimmed key to the regional Speech host by default", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const stubFetch = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return Response.json(restBody());
  }) as unknown as typeof fetch;
  const result = await assess(sampleClip(), "think", "en-US", { subscriptionKey: "  azure-key  ", region: " westus ", fetch: stubFetch });
  assertOk(result);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://westus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed",
  );
  assert.equal(calls[0]?.headers["Ocp-Apim-Subscription-Key"], "azure-key");
});

test("assess returns unavailable without a key", async () => {
  const result = await assess(sampleClip(), "hello", "en-US", { subscriptionKey: "", region: "westus" });
  assert.deepEqual(result, { status: "unavailable", reason: "Add an Azure Speech key in Language coach settings." });
});

test("assess returns unavailable on Azure HTTP errors and timeouts", async () => {
  const errorResult = await assessVia((_request, response) => sendJson(response, 503, { error: "busy" }));
  assertUnavailable(errorResult, /503/);

  const timeoutResult = await assessVia(() => {}, { timeoutMs: 25 });
  assertUnavailable(timeoutResult, "Azure pronunciation assessment timed out.");
});

test("assess returns unavailable when Azure sends an unreadable body", async () => {
  const result = await assessVia((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{ not json");
  });
  assert.equal(result.status, "unavailable");
});

test("assess returns unavailable when the response body times out", async () => {
  const result = await assessVia((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"NBest\":");
  }, { timeoutMs: 50 });
  assertUnavailable(result, "Azure pronunciation assessment timed out.");
});

test("the pronunciation header is Base64-encoded JSON that keeps non-ASCII reference text", () => {
  const header = buildPronunciationAssessmentHeader("你好 😀", "zh-CN");
  assert.match(header, /^[A-Za-z0-9+/]+={0,2}$/);
  const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { ReferenceText: string };
  assert.equal(parsed.ReferenceText, "你好 😀");
});

// Azure's REST endpoint reports the scores flat; the Speech SDK nests them under PronunciationAssessment,
// which is the shape the fixtures above still use.
test("the REST response shape maps the scores Azure returns on the best entry and its words", async () => {
  const ok = assertOk(await assessVia(respondJson(restBody())));
  assert.equal(ok.scores.accuracy, 88);
  assert.equal(ok.scores.fluency, 90);
  assert.equal(ok.scores.completeness, 95);
  assert.equal(ok.scores.prosody, 72);
  assert.deepEqual(ok.words, [{ word: "think", score: 70, phonemes: [{ phoneme: "θ", score: 42, heard: ["s", "θ"] }] }]);
  assert.deepEqual(ok.phonemes?.[0], { phoneme: "θ", score: 42, heard: ["s", "θ"] });
});

const READABLE_STATUSES: [string, string][] = [
  ["NoMatch", "Azure could not recognise any speech in the recording."],
  ["InitialSilenceTimeout", "Azure heard only silence at the start of the recording."],
  ["BabbleTimeout", "Azure heard only background noise in the recording."],
  ["Error", "Azure could not process the recording."],
  ["SomethingNew", "Azure recognition status was SomethingNew."],
];

for (const [status, reason] of READABLE_STATUSES) {
  test(`a ${status} response is unavailable with a readable reason, never a zero-score assessment`, async () => {
    const result = await assessVia(respondJson({ RecognitionStatus: status, NBest: [{ Words: [] }] }));
    assertUnavailable(result, reason);
  });
}

test("a Success response without any assessment fields is unavailable, never a zero score", async () => {
  const result = await assessVia(respondJson({ RecognitionStatus: "Success", NBest: [{ Display: "Hello." }] }));
  assertUnavailable(result, UNEXPECTED_PAYLOAD);
});

const MISSING_SCORES: [string, Parameters<typeof restBody>[0]][] = [
  ["accuracy", { best: { AccuracyScore: undefined } }],
  ["fluency", { best: { FluencyScore: undefined } }],
  ["completeness", { best: { CompletenessScore: undefined } }],
  ["a non-numeric accuracy", { best: { AccuracyScore: "88" } }],
  ["a word", { word: { AccuracyScore: undefined } }],
  ["a phoneme", { phoneme: { AccuracyScore: undefined } }],
];

for (const [name, parts] of MISSING_SCORES) {
  test(`a response missing ${name} score is unavailable instead of a zero`, async () => {
    assertUnavailable(await assessVia(respondJson(restBody(parts))), UNEXPECTED_PAYLOAD);
  });
}

test("a zh-CN response with a syllable that has no score is unavailable instead of a zero", async () => {
  const body = restBody();
  (body.NBest as Entry[])[0]!.Words = [{ Word: "你好", AccuracyScore: 80, Syllables: [{ Syllable: "ni3", Pinyin: "nǐ" }] }];
  assertUnavailable(await assessVia(respondJson(body), { locale: "zh-CN" }), UNEXPECTED_PAYLOAD);
});

test("an explicit zero score is a real score", async () => {
  const ok = assertOk(await assessVia(respondJson(restBody({ best: { AccuracyScore: 0 }, word: { AccuracyScore: 0 } }))));
  assert.equal(ok.scores.accuracy, 0);
  assert.deepEqual(ok.words, [{ word: "think", score: 0, phonemes: [{ phoneme: "θ", score: 42, heard: ["s", "θ"] }] }]);
});
