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
import { GAP_KINDS, literalReaderInstructions, type GapKind } from "../src/contract.ts";
import { fixWordingInstructions, type JevRuntime } from "../src/grader.ts";
import { sendJson, stubJsonServer } from "./support/http-stub.ts";

type Grade = (context: PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer>) => Promise<ExplainBackResult>;

function reply(text: string, stopReason: "stop" | "error" | "aborted" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "The provider refused the request." } : {}),
  } as unknown as AssistantMessage;
}

function catalogModel(id: string, provider: string): ModelCatalogResponse["models"][number] {
  return {
    id,
    name: `${provider}/${id}`,
    provider,
    reasoning: false,
    input: ["text"],
    supportedLevels: ["off", "low", "high"],
    cost: null,
    contextWindow: null,
    maxTokens: null,
  };
}

function chatWith(settings: ChatRecord["settings"]): ChatRecord {
  return {
    id: "chat-fixture",
    title: "Explain-back fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    settings,
  };
}

function catalog(defaults: ModelCatalogResponse["defaults"] = { model: { provider: "test", id: "default-model" }, thinkingLevel: "low" }): ModelCatalogResponse {
  return {
    defaults,
    models: [catalogModel("default-model", "test"), catalogModel("session-model", "test")],
    rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null, sideQuestion: null },
    slots: { strong: null, cheap: null, vision: null },
    providers: [],
  };
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

const claudeSession = chatWith({ model: { provider: "claude-code", id: "opus" }, thinkingLevel: "high" });

function claudeCatalog(cheap: ModelCatalogResponse["slots"]["cheap"]): ModelCatalogResponse {
  return {
    defaults: { model: { provider: "claude-code", id: "opus" }, thinkingLevel: "high" },
    models: [catalogModel("opus", "claude-code"), catalogModel("sonnet", "claude-code")],
    rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null, sideQuestion: null },
    slots: { strong: null, cheap, vision: null },
    providers: [],
  };
}

const jevNoul: Record<GapKind, number> = {
  "missing step": 0.4,
  "undefined term": 0.4,
  "wrong order": 0.4,
  "conclusion buried": 0.4,
};

/** A Jev reply that picks the missing-step criterion, so scoring reaches the fix-wording call. */
const jevReply = {
  model: "jev-1.14.0",
  answers: {
    ...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul" as const, noul: jevNoul[kind] }])),
    fix: { type: "choice" as const, choice: "missing step" as const, confidence: 0.64, probabilities: { "missing step": 0.82 } },
  },
};

/** Answer both grading prompts so the literal reader and the fix wording each complete. */
async function answerBothPrompts(request: PluginInferenceRequest): Promise<AssistantMessage> {
  const text = request.context.systemPrompt === fixWordingInstructions ? "Next time, state that squaring 2k gives 4k²." : JSON.stringify(gradedPayload);
  return reply(text);
}

async function failFixWording(request: PluginInferenceRequest): Promise<AssistantMessage> {
  if (request.context.systemPrompt === fixWordingInstructions) throw new Error("The provider refused the fix wording.");
  return reply(JSON.stringify(gradedPayload));
}

async function blankFixWording(request: PluginInferenceRequest): Promise<AssistantMessage> {
  if (request.context.systemPrompt === fixWordingInstructions) return reply("   ");
  return reply(JSON.stringify(gradedPayload));
}

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
  typesafeKey?: string;
  jev?: JevRuntime;
} = {}) {
  let definition: PluginQuestionTypeDefinition | undefined;
  const requests: PluginInferenceRequest[] = [];
  const handlers = new Map<string, (input: unknown) => unknown>();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-"));
  temporaryDirectories.push(dataDirectory);
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle(name: string, handler: (input: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
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
  } as unknown as PluginBackendContext, { jev: options.jev });
  assert.ok(definition?.gradeAnswer, "activation registers a grader");
  if (options.typesafeKey) handlers.get("set-typesafe-key")!({ key: options.typesafeKey });
  return { grade: definition.gradeAnswer as unknown as Grade, requests, cleanup };
}

test("grades through the session model and returns the literal reconstruction and named gaps", async () => {
  const session = chatWith({ model: { provider: "test", id: "session-model" }, thinkingLevel: "high" });
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
  const f = fixture({ session: chatWith({}) });
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

test("both grading calls run on the cheap-slot model when one is configured", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevReply));
  const f = fixture({
    session: claudeSession,
    catalog: claudeCatalog({ model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "low" }),
    complete: answerBothPrompts,
    typesafeKey: "sk-typesafe-grading",
    jev: { endpoint: stub.url, timeoutMs: 500 },
  });
  try {
    const result = await f.grade(gradingContext());
    if (!result.scoring || result.scoring.status !== "ok") assert.fail("expected criterion scoring to succeed");
    const fix = jevReply.answers.fix;
    assert.equal(result.scoring.fix.criterion, fix.choice);
    assert.equal(result.scoring.fix.probability, fix.probabilities[fix.choice]);
    assert.notEqual(result.scoring.fix.probability, fix.confidence);
    assert.equal(result.scoring.fix.wording, "Next time, state that squaring 2k gives 4k².");
    for (const kind of GAP_KINDS) assert.equal(result.scoring.criteria[kind], jevNoul[kind]);
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.deepEqual(request.model, { provider: "claude-code", id: "sonnet", thinkingLevel: "low" });
    }
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("with no cheap slot both grading calls keep the session model", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevReply));
  const f = fixture({
    session: claudeSession,
    catalog: claudeCatalog(null),
    complete: answerBothPrompts,
    typesafeKey: "sk-typesafe-grading",
    jev: { endpoint: stub.url, timeoutMs: 500 },
  });
  try {
    const result = await f.grade(gradingContext());
    if (!result.scoring || result.scoring.status !== "ok") assert.fail("expected criterion scoring to succeed");
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.deepEqual(request.model, { provider: "claude-code", id: "opus", thinkingLevel: "high" });
    }
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("a cheap slot whose model is missing from the catalog falls back to the session model", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevReply));
  const f = fixture({
    session: claudeSession,
    catalog: claudeCatalog({ model: { provider: "claude-code", id: "haiku" } }),
    complete: answerBothPrompts,
    typesafeKey: "sk-typesafe-grading",
    jev: { endpoint: stub.url, timeoutMs: 500 },
  });
  try {
    const result = await f.grade(gradingContext());
    if (!result.scoring || result.scoring.status !== "ok") assert.fail("expected criterion scoring to succeed");
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.deepEqual(request.model, { provider: "claude-code", id: "opus", thinkingLevel: "high" });
    }
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("a blank fix-wording reply names the model and the missing wording", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevReply));
  const f = fixture({
    session: claudeSession,
    catalog: claudeCatalog({ model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "low" }),
    complete: blankFixWording,
    typesafeKey: "sk-typesafe-grading",
    jev: { endpoint: stub.url, timeoutMs: 500 },
  });
  try {
    const result = await f.grade(gradingContext());
    if (!result.scoring || result.scoring.status !== "unavailable") assert.fail("expected scoring to be unavailable with a reason");
    assert.equal(result.scoring.reason, "The explain-back model claude-code/sonnet returned no fix wording.");
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("a failed fix-wording call on the cheap-slot model names it in the unavailable reason", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevReply));
  const f = fixture({
    session: claudeSession,
    catalog: claudeCatalog({ model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "low" }),
    complete: failFixWording,
    typesafeKey: "sk-typesafe-grading",
    jev: { endpoint: stub.url, timeoutMs: 500 },
  });
  try {
    const result = await f.grade(gradingContext());
    if (!result.scoring || result.scoring.status !== "unavailable") assert.fail("expected scoring to be unavailable with a reason");
    assert.match(result.scoring.reason, /claude-code\/sonnet could not write the fix wording/);
  } finally {
    f.cleanup();
    await stub.close();
  }
});
