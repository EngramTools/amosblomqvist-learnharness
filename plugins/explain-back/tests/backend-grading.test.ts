import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ChatRecord,
  JsonValue,
  ModelCatalogResponse,
  PluginBackendContext,
  PluginInferenceRequest,
  PluginQuestionGradingContext,
  PluginQuestionTypeDefinition,
} from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import type { ExplainBackAnswer, ExplainBackPayload, ExplainBackResult } from "../src/contract.ts";
import { literalReaderInstructions } from "../src/contract.ts";

type Grade = (context: PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer>) => Promise<ExplainBackResult>;

function reply(text: string, stopReason: "stop" | "error" | "aborted" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "The provider refused the request." } : {}),
  } as unknown as AssistantMessage;
}

function catalog(defaults: ModelCatalogResponse["defaults"] = { model: { provider: "test", id: "default-model" }, thinkingLevel: "low" }): ModelCatalogResponse {
  return {
    defaults,
    models: [
      { id: "default-model", provider: "test" },
      { id: "session-model", provider: "test" },
    ],
    rolePins: {},
    slots: {},
    providers: [],
  } as unknown as ModelCatalogResponse;
}

const payload: ExplainBackPayload = {
  step: "Every even square is divisible by 4.",
  premises: [
    "An even number can be written as 2k.",
    "Squaring 2k gives 4k².",
  ],
};
const explanation = "An even number is 2k, so its square is 4k² and divisible by 4.";
const gradedPayload = {
  version: 1,
  reconstruction: "An even number is 2k, and its square is 4k².",
  gaps: [{ kind: "missing step", detail: "Squaring 2k gives 4k²." }],
};
const noKeyScoring = {
  status: "unavailable" as const,
  reason: "No TypeSafe API key is configured, so criterion scoring is unavailable.",
};
const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function gradingContext(signal = new AbortController().signal): PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer> {
  return {
    chatId: "chat-fixture",
    questionId: "question-fixture",
    variant: "teach",
    contractVersion: 1,
    input: { type: "check", nodeId: "node-fixture", question: "Why is an even square divisible by 4?", payload },
    answer: { text: explanation },
    signal,
  };
}

function fixture(options: {
  session?: ChatRecord | null;
  catalog?: ModelCatalogResponse;
  complete?: (request: PluginInferenceRequest) => Promise<AssistantMessage>;
} = {}) {
  let definition: PluginQuestionTypeDefinition | undefined;
  const requests: PluginInferenceRequest[] = [];
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-"));
  temporaryDirectories.push(dataDirectory);
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle() { return () => {}; },
    inference: {
      catalog: async () => options.catalog ?? catalog(),
      complete: async (request: PluginInferenceRequest) => {
        requests.push(request);
        return options.complete ? options.complete(request) : reply(JSON.stringify(gradedPayload));
      },
    },
    learning: { getSession: () => options.session ?? null },
    registerQuestionType(value: typeof definition) {
      definition = value;
      return () => {};
    },
  } as unknown as PluginBackendContext);
  assert.ok(definition?.gradeAnswer, "activation registers a grader");
  return { grade: definition.gradeAnswer as unknown as Grade, requests, cleanup };
}

test("grades through the session model and returns the literal reconstruction and named gaps", async () => {
  const session = { settings: { model: { provider: "test", id: "session-model" }, thinkingLevel: "high" } } as unknown as ChatRecord;
  const f = fixture({ session });
  const result = await f.grade(gradingContext());

  assert.deepEqual(result, { ...gradedPayload, scoring: noKeyScoring });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.deepEqual(request.model, { provider: "test", id: "session-model", thinkingLevel: "high" });
  assert.equal(request.purpose, "user");
  assert.equal(request.context.systemPrompt, literalReaderInstructions);
  assert.match(request.context.systemPrompt!, /never supply a premise, definition, connection, or intermediate conclusion the learner did not state/i);
  const message = request.context.messages[0];
  assert.equal(message?.role, "user");
  const text = typeof message?.content === "string" ? message.content : "";
  assert.match(text, /Every even square is divisible by 4\./);
  assert.match(text, /Squaring 2k gives 4k²\./);
  assert.match(text, /An even number is 2k, so its square is 4k² and divisible by 4\./);
  f.cleanup();
});

test("a missing premise produces a missing-step gap naming it while instructions forbid supplying it", async () => {
  const f = fixture();
  const context = gradingContext();
  const omitted = context.input.payload.premises[1]!;
  const result = await f.grade({ ...context, answer: { text: "An even number is 2k, so its square is divisible by 4." } });

  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0]!.kind, "missing step");
  assert.equal(result.gaps[0]!.detail, omitted);
  const text = String(f.requests[0]!.context.messages[0]!.content);
  assert.match(text, new RegExp(omitted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(f.requests[0]!.context.systemPrompt!, /never supply a premise/i);
});

test("an empty reconstruction with a missing-step gap is a valid result, not a grading error", async () => {
  const gap = { kind: "missing step", detail: "Squaring 2k gives 4k²." };
  const f = fixture({ complete: async () => reply(JSON.stringify({ version: 1, reconstruction: "", gaps: [gap] })) });
  const context = gradingContext();
  const result = await f.grade({ ...context, answer: { text: "Something about evens." } });
  assert.deepEqual(result, { version: 1, reconstruction: "", gaps: [gap], scoring: noKeyScoring });
  assert.match(f.requests[0]!.context.systemPrompt!, /establish nothing, return an empty reconstruction/i);
  f.cleanup();
});

test("falls back to the strong-slot default when the session has no model override", async () => {
  const f = fixture({ session: { settings: {} } as unknown as ChatRecord });
  await f.grade(gradingContext());
  assert.deepEqual(f.requests[0]!.model, { provider: "test", id: "default-model", thinkingLevel: "low" });
});

test("accepts a fenced JSON reply and rejects unreadable or invalid results", async () => {
  const fenced = fixture({ complete: async () => reply("```json\n" + JSON.stringify(gradedPayload) + "\n```") });
  assert.deepEqual(await fenced.grade(gradingContext()), { ...gradedPayload, scoring: noKeyScoring });

  const invalidKind = fixture({ complete: async () => reply(JSON.stringify({ ...gradedPayload, gaps: [{ kind: "missing premise", detail: "Something" }] })) });
  await assert.rejects(invalidKind.grade(gradingContext()), /invalid result/i);

  const unreadable = fixture({ complete: async () => reply("I could not read that.") });
  await assert.rejects(unreadable.grade(gradingContext()), /readable JSON/i);
});

test("a failed model call rejects so the host saves the answer with a readable grading error", async () => {
  const f = fixture({ complete: async () => { throw new Error("Provider connection failed."); } });
  await assert.rejects(f.grade(gradingContext()), /Provider connection failed\./);

  const truncated = fixture({ complete: async () => reply("{\"version\":1", "error") });
  await assert.rejects(truncated.grade(gradingContext()), /literal reader could not finish: The provider refused the request\./);
});

test("an unconfigured model and an aborted submission reject before inference", async () => {
  const unavailable = fixture({ catalog: catalog(null) });
  await assert.rejects(unavailable.grade(gradingContext()), /No model is configured for this session/i);

  const controller = new AbortController();
  controller.abort();
  const aborted = fixture();
  await assert.rejects(aborted.grade(gradingContext(controller.signal)), { name: "AbortError" });
  assert.equal(aborted.requests.length, 0);
});
