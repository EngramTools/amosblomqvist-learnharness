import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ChatRecord,
  ModelCatalogResponse,
  PluginBackendContext,
  PluginInferenceRequest,
  PluginQuestionGradingContext,
  PluginQuestionTypeDefinition,
} from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { GAP_KINDS, literalReaderInstructions, type ExplainBackAnswer, type ExplainBackPayload, type GapKind } from "../src/contract.ts";
import { buildFixWordingMessage, fixWordingInstructions, readFixWording, trimToTwoSentences } from "../src/grader.ts";
import { sendJson, stubJsonServer } from "./support/http-stub.ts";

const API_KEY = "sk-typesafe-secret-123";
const payload: ExplainBackPayload = {
  step: "Every even square is divisible by 4.",
  premises: ["An even number is 2k.", "Squaring 2k gives 4k²."],
};
const explanation = "An even number is 2k, so its square is 4k² and divisible by 4.";
const literalResult = {
  version: 1 as const,
  reconstruction: "An even number is 2k, and its square is 4k².",
  gaps: [{ kind: "missing step" as const, detail: "Squaring 2k gives 4k²." }],
};
const criteria: Record<GapKind, number> = {
  "missing step": 0.82,
  "undefined term": 0.11,
  "wrong order": 0.04,
  "conclusion buried": 0.27,
};
const wording = "Say that squaring 2k gives 4k² before concluding divisibility by 4.";
const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-paths-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reply(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as unknown as AssistantMessage;
}

function catalog(): ModelCatalogResponse {
  return {
    defaults: { model: { provider: "test", id: "default-model" }, thinkingLevel: "low" },
    models: [{ id: "default-model", provider: "test" }],
    rolePins: {},
    slots: {},
    providers: [],
  } as unknown as ModelCatalogResponse;
}

type Grade = (context: PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer>) => Promise<{
  reconstruction: string;
  scoring: { status: string; criteria?: Record<string, number>; fix?: { criterion: string; probability: number; wording?: string; unavailableReason?: string }; reason?: string };
}>;

type FixtureOptions = {
  jevBody?: () => unknown;
  jevEndpoint?: string;
  jevFetch?: typeof fetch;
  wordingReplies?: (request: PluginInferenceRequest) => string;
  failWording?: () => Error;
};

function fixture(options: FixtureOptions = {}) {
  const dataDirectory = tempDirectory();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const requests: PluginInferenceRequest[] = [];
  let definition: PluginQuestionTypeDefinition | undefined;
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle(name: string, handler: (input: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    inference: {
      catalog: async () => catalog(),
      complete: async (request: PluginInferenceRequest) => {
        requests.push(request);
        const systemPrompt = request.context.systemPrompt ?? "";
        if (systemPrompt === literalReaderInstructions) return reply(JSON.stringify(literalResult));
        if (systemPrompt === fixWordingInstructions) {
          if (options.failWording) throw options.failWording();
          return reply(options.wordingReplies?.(request) ?? wording);
        }
        throw new Error("Unexpected inference request.");
      },
    },
    learning: { getSession: () => null as ChatRecord | null },
    registerQuestionType(value: typeof definition) {
      definition = value;
      return () => {};
    },
  } as unknown as PluginBackendContext, { jev: { endpoint: options.jevEndpoint, fetch: options.jevFetch, timeoutMs: 500 } });
  assert.ok(definition?.gradeAnswer);
  return {
    grade: definition.gradeAnswer as unknown as Grade,
    handlers,
    requests,
    dataDirectory,
    cleanup,
    jevBody: options.jevBody,
  };
}

function gradingContext(signal?: AbortSignal): PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer> {
  return {
    chatId: "chat-fixture",
    questionId: "question-fixture",
    variant: "teach",
    contractVersion: 1,
    input: { type: "check", nodeId: "node-fixture", question: "Why is an even square divisible by 4?", payload },
    answer: { text: explanation },
    signal: signal ?? new AbortController().signal,
  };
}

function jevResponse(overrides: {
  noul?: (kind: GapKind) => number;
  fixProbability?: number;
  fixChoice?: string;
} = {}) {
  return {
    model: "jev-1.14.0",
    answers: {
      ...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: overrides.noul?.(kind) ?? criteria[kind] }])),
      fix: {
        type: "choice",
        choice: overrides.fixChoice ?? "missing step",
        confidence: 0.64,
        probabilities: { ...criteria, "missing step": overrides.fixProbability ?? criteria["missing step"] },
      },
    },
  };
}

async function gradedScores(options: FixtureOptions) {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, options.jevBody?.() ?? jevResponse()));
  const f = fixture({ ...options, jevEndpoint: options.jevEndpoint ?? stub.url });
  try {
    f.handlers.get("set-typesafe-key")!({ key: API_KEY });
    return { result: await f.grade(gradingContext()), requests: f.requests, close: () => stub.close() };
  } finally {
    f.cleanup();
  }
}

test("a negative noul probability marks scoring unavailable instead of grading", async () => {
  const { result, close } = await gradedScores({ jevBody: () => jevResponse({ noul: kind => (kind === "missing step" ? -0.05 : criteria[kind]) }) });
  try {
    assert.equal(result.scoring.status, "unavailable");
    assert.match(result.scoring.reason!, /unreadable/i);
    assert.equal("criteria" in result.scoring, false);
  } finally {
    await close();
  }
});

test("a fix probability above one marks scoring unavailable instead of grading", async () => {
  const { result, close } = await gradedScores({ jevBody: () => jevResponse({ fixProbability: 1.2 }) });
  try {
    assert.equal(result.scoring.status, "unavailable");
    assert.match(result.scoring.reason!, /unreadable/i);
  } finally {
    await close();
  }
});

test("the fix-wording prompt carries every criterion score and the chosen fix", () => {
  const message = buildFixWordingMessage({
    payload,
    explanation,
    result: literalResult,
    scores: {
      model: "jev-1.14.0",
      criteria: { ...criteria, "filler rate high": 0.31 },
      fix: { criterion: "wrong order", probability: 0.66 },
    },
  });
  assert.match(message, /Criterion gap probabilities/);
  for (const [kind, value] of Object.entries(criteria)) assert.match(message, new RegExp(`- ${kind}: ${value}`));
  assert.match(message, /- filler rate high: 0\.31/);
  assert.match(message, /The learner should fix this next: wrong order \(0\.66\)\./);
  assert.match(message, /one or two sentences/);
});

test("the literal-reader prompt fences the learner text and numbers the premises", async () => {
  const { requests, close } = await gradedScores({});
  try {
    const message = String(requests[0]!.context.messages[0]!.content);
    assert.match(message, /<learner-explanation>\nAn even number is 2k[\s\S]*<\/learner-explanation>/);
    assert.match(message, /1\. An even number is 2k\./);
    assert.match(message, /2\. Squaring 2k gives 4k²\./);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.context.systemPrompt, fixWordingInstructions);
    assert.match(String(requests[1]!.context.messages[0]!.content), /The learner should fix this next: missing step \(0\.82\)/);
  } finally {
    await close();
  }
});

test("fix wording longer than two sentences is trimmed to two", async () => {
  const three = "First fix the order. Then define k. Then restate the conclusion.";
  const { result, close } = await gradedScores({ wordingReplies: () => three });
  try {
    assert.equal(result.scoring.status, "ok");
    assert.equal(result.scoring.fix!.wording, "First fix the order. Then define k.");
  } finally {
    await close();
  }
});

test("trimming keeps at most two sentences and rejects blank wording", () => {
  assert.equal(trimToTwoSentences("One. Two. Three. Four."), "One. Two.");
  assert.equal(trimToTwoSentences("One question? Two!"), "One question? Two!");
  assert.equal(trimToTwoSentences("No terminator at all"), "No terminator at all");
  assert.equal(trimToTwoSentences("   "), "");
  assert.equal(
    trimToTwoSentences("First, use 2.5 as the factor. Then define k. Finally restate."),
    "First, use 2.5 as the factor. Then define k.",
  );
  const model = { provider: "test", id: "default-model" };
  assert.throws(() => readFixWording("   ", model), /returned no fix wording/);
});

test("a failed fix-wording call keeps the Jev scores and explains the missing wording", async () => {
  const { result, close } = await gradedScores({ failWording: () => new Error("The provider refused the fix wording.") });
  try {
    assert.equal(result.scoring.status, "ok");
    assert.deepEqual(result.scoring.criteria, criteria);
    assert.deepEqual(result.scoring.fix, {
      criterion: "missing step",
      probability: 0.82,
      unavailableReason: "The explain-back model test/default-model could not write the fix wording.",
    });
    assert.equal("wording" in result.scoring.fix!, false);
  } finally {
    await close();
  }
});

test("an abort during the Jev call cancels grading and never reaches the wording model", async () => {
  const gate = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const slowFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    sent.resolve();
    await gate.promise;
    return response;
  };
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevResponse()));
  const f = fixture({ jevEndpoint: stub.url, jevFetch: slowFetch });
  try {
    f.handlers.get("set-typesafe-key")!({ key: API_KEY });
    const controller = new AbortController();
    const pending = f.grade(gradingContext(controller.signal));
    await sent.promise;
    controller.abort(new Error("cancelled by the learner"));
    gate.resolve();
    await assert.rejects(pending, /cancelled by the learner/);
    assert.equal(f.requests.length, 1);
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("a stored key survives reactivation, trimmed, and a key at the length cap is accepted", () => {
  const f = fixture();
  try {
    assert.throws(() => f.handlers.get("set-typesafe-key")!({ key: "k".repeat(4097) }), /too long/);
    f.handlers.get("set-typesafe-key")!({ key: `  ${"k".repeat(4096)}  ` });
    const stored = JSON.parse(fs.readFileSync(path.join(f.dataDirectory, "settings.json"), "utf8")) as { typesafeApiKey: string };
    assert.equal(stored.typesafeApiKey.length, 4096);
    f.cleanup();
    const reloaded = fixtureWithDirectory(f.dataDirectory);
    try {
      assert.deepEqual(reloaded.handlers.get("get-settings")!({}), { hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 });
    } finally {
      reloaded.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test("a corrupt settings file is a distinct activation error, not a missing key", () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, "settings.json"), "{not json");
  assert.throws(() => fixtureWithDirectory(directory), {
    message: "the explain-back settings file is corrupt: it does not contain valid JSON.",
  });
  fs.writeFileSync(path.join(directory, "settings.json"), "a bare string");
  assert.throws(() => fixtureWithDirectory(directory), /corrupt/i);
  fs.writeFileSync(path.join(directory, "settings.json"), "[]");
  assert.throws(() => fixtureWithDirectory(directory), /corrupt/i);
  fs.rmSync(path.join(directory, "settings.json"));
  const activated = fixtureWithDirectory(directory);
  try {
    assert.deepEqual(activated.handlers.get("get-settings")!({}), { hasTypesafeKey: false, interviewMode: false, pauseThresholdSeconds: 2 });
  } finally {
    activated.cleanup();
  }
});

test("a corrupt settings file never echoes its contents into the activation error", () => {
  const directory = tempDirectory();
  const secret = "sk-typesafe-secret-from-corrupt-file";
  fs.writeFileSync(path.join(directory, "settings.json"), `{"typesafeApiKey": "${secret}"} trailing`);
  assert.throws(() => fixtureWithDirectory(directory), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "the explain-back settings file is corrupt: it does not contain valid JSON.");
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test("an unreadable settings path is a read error, not a missing key or corrupt file", () => {
  const directory = tempDirectory();
  fs.mkdirSync(path.join(directory, "settings.json"));
  assert.throws(() => fixtureWithDirectory(directory), {
    message: "Could not read the explain-back settings file.",
  });
});

function fixtureWithDirectory(directory: string) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  let definition: PluginQuestionTypeDefinition | undefined;
  const cleanup = activate({
    dataDirectory: directory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle(name: string, handler: (input: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    inference: { catalog: async () => catalog(), complete: async () => reply("{}") },
    learning: { getSession: () => null as ChatRecord | null },
    registerQuestionType(value: typeof definition) { definition = value; return () => {}; },
  } as unknown as PluginBackendContext);
  assert.ok(definition);
  return { cleanup, handlers };
}
