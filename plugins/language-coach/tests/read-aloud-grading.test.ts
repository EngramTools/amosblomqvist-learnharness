import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { PluginBackendContext, PluginQuestionGradingContext, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { AssessmentResult } from "../src/judge-types.ts";
import type { ReadAloudAnswer, ReadAloudPayload, ReadAloudResult } from "../src/read-aloud-contract.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";

const temporaryDirectories: string[] = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });

/** Azure heard /θ/ in "think" as /s/: one low phoneme with one heard alternative. */
const THINK_MISHEARD: AssessmentResult = {
  status: "ok",
  words: [{
    word: "think",
    score: 55,
    phonemes: [
      { phoneme: "θ", score: 20, heard: ["s"] },
      { phoneme: "ɪ", score: 90, heard: ["ɪ"] },
      { phoneme: "ŋ", score: 90, heard: ["ŋ"] },
      { phoneme: "k", score: 90, heard: ["k"] },
    ],
  }],
  scores: { accuracy: 55, fluency: 80, completeness: 100 },
};

type Grade = (context: PluginQuestionGradingContext<ReadAloudPayload, ReadAloudAnswer>) => Promise<ReadAloudResult>;

function fixture(judged: AssessmentResult) {
  let definition: PluginQuestionTypeDefinition | undefined;
  const instructions: { agents: string[]; text: string }[] = [];
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "language-coach-grade-"));
  temporaryDirectories.push(dataDirectory);
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle() { return () => {}; },
    registerQuestionType(value: typeof definition) {
      definition = value;
      return () => { definition = undefined; };
    },
    registerInstructions(contribution: { agents: string[]; text: string }) {
      instructions.push(contribution);
      return () => {};
    },
  } as unknown as PluginBackendContext, {
    judge: {
      subscriptionKey: "test-key",
      region: "westus",
      fetch: async () => {
        // The stubbed judge seam: answer the short-audio request with the fixed assessment, or a failed status.
        const unavailable = judged.status !== "ok";
        const stub: unknown = unavailable ? { RecognitionStatus: "Mispronunciations" } : {
          RecognitionStatus: "Success",
          NBest: [{
            AccuracyScore: judged.scores.accuracy,
            FluencyScore: judged.scores.fluency,
            CompletenessScore: judged.scores.completeness,
            Words: judged.words.map(word => ({
              Word: word.word,
              PronunciationAssessment: { AccuracyScore: word.score },
              Phonemes: (word.phonemes ?? []).map(phoneme => ({
                Phoneme: phoneme.phoneme,
                PronunciationAssessment: { AccuracyScore: phoneme.score },
                NBestPhonemes: phoneme.heard.map(heard => ({ Phoneme: heard })),
              })),
              Syllables: (word.syllables ?? []).map(syllable => ({
                Syllable: syllable.syllable,
                Pinyin: syllable.pinyin,
                PronunciationAssessment: { AccuracyScore: syllable.score },
              })),
            })),
          }],
        };
        return new Response(JSON.stringify(stub), { status: 200 });
      },
    } as never,
  });
  assert.ok(definition?.gradeAnswer, "activation registers the read-aloud question type");
  return { definition: definition!, instructions, cleanup };
}

function recordingBase64(): string {
  return Buffer.from(encodeWav16kMono(new Float32Array(800), 16_000)).toString("base64");
}

function gradingContext(payload: ReadAloudPayload, recording: string): PluginQuestionGradingContext<ReadAloudPayload, ReadAloudAnswer> {
  return {
    chatId: "chat-fixture",
    questionId: "question-fixture",
    variant: "teach",
    contractVersion: 1,
    input: { type: "check", nodeId: "node-fixture", question: "Read this aloud.", payload },
    answer: { recording },
    signal: new AbortController().signal,
  };
}

test("activation registers the read-aloud question and the teacher instructions", () => {
  const f = fixture(THINK_MISHEARD);
  assert.equal(f.definition.id, "read-aloud");
  assert.equal(f.definition.contractVersion, 1);
  assert.ok(f.definition.teach, "the teacher can pose the drill");
  assert.equal(f.instructions.length, 1);
  assert.match(f.instructions[0]!.text, /read.?aloud/i);
  assert.match(f.instructions[0]!.text, /bundled dictionar/i);
  f.cleanup();
});

test("grading think with θ heard as s saves a low θ with heard /s/", async () => {
  const f = fixture(THINK_MISHEARD);
  const grade = f.definition.gradeAnswer as unknown as Grade;
  const result = await grade(gradingContext({ text: "think", language: "en-US" }, recordingBase64()));
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" ? result.words.length : 0, 1);
  const word = result.status === "ok" ? result.words[0]! : null;
  assert.equal(word?.word, "think");
  const lowTheta = word?.phonemes?.find(phoneme => phoneme.phoneme === "θ");
  assert.ok(lowTheta, "the θ phoneme is reported");
  assert.ok(lowTheta.score < 50, `θ scored low, got ${lowTheta.score}`);
  assert.equal(lowTheta.heard, "s");
  assert.equal(word?.phonemes?.find(phoneme => phoneme.phoneme === "ŋ")?.score, 90);
  f.cleanup();
  // Hand the exact saved JSON to the renderer test via a fixture file.
  const shared = path.join(os.tmpdir(), "language-coach-grade-fixture.json");
  fs.writeFileSync(shared, JSON.stringify(result));
});

test("a word missing from CMUdict reports no dictionary pronunciation", async () => {
  const f = fixture({ ...THINK_MISHEARD, words: [{ word: "qqzzvv", score: 60 }] });
  const grade = f.definition.gradeAnswer as unknown as Grade;
  const result = await grade(gradingContext({ text: "think qqzzvv", language: "en-US" }, recordingBase64()));
  const words = result.status === "ok" ? result.words : [];
  assert.equal(words[0]?.word, "think");
  assert.equal(words[1]?.word, "qqzzvv");
  assert.equal(words[1]?.noDictionaryPronunciation, true);
  assert.equal(words[1]?.phonemes, undefined);
  f.cleanup();
});

test("judge unavailability saves as a reason with no score", async () => {
  const f = fixture({ status: "unavailable", reason: "Azure recognition status was Mispronunciations." });
  const grade = f.definition.gradeAnswer as unknown as Grade;
  const result = await grade(gradingContext({ text: "think", language: "en-US" }, recordingBase64()));
  assert.deepEqual(result, { status: "unavailable", reason: "Azure recognition status was Mispronunciations." });
  f.cleanup();
});

test("Mandarin grading reports per-syllable pinyin with tone marks", async () => {
  const f = fixture({
    status: "ok",
    words: [{ word: "你好", score: 70, syllables: [{ syllable: "1", pinyin: "nǐ", score: 85 }, { syllable: "2", pinyin: "hǎo", score: 60 }] }],
    scores: { accuracy: 70, fluency: 80, completeness: 100 },
  });
  const grade = f.definition.gradeAnswer as unknown as Grade;
  const result = await grade(gradingContext({ text: "你好", language: "zh-CN" }, recordingBase64()));
  const word = result.status === "ok" ? result.words[0] : undefined;
  assert.deepEqual(word?.syllables?.map(syllable => syllable.pinyin), ["nǐ", "hǎo"]);
  assert.deepEqual(word?.syllables?.map(syllable => syllable.score), [85, 60]);
  f.cleanup();
});
