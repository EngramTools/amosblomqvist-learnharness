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
import {
  GAP_KINDS,
  literalReaderInstructions,
  type ExplainBackAnswer,
  type ExplainBackPayload,
  type GapKind,
} from "../src/contract.ts";
import { fixWordingInstructions } from "../src/grader.ts";
import { sendJson, stubJsonServer } from "./support/http-stub.ts";

type Handler = (input: unknown) => unknown | Promise<unknown>;
type Grade = (context: PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer>) => Promise<{
  version: 1;
  reconstruction: string;
  gaps: { kind: GapKind; detail: string }[];
  scoring: { status: string; criteria?: Record<GapKind, number>; fix?: { criterion: GapKind; probability: number; wording: string }; reason?: string };
}>;

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
const wording = "Next time, say that squaring 2k gives 4k² before concluding divisibility by 4.";
const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-scoring-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reply(text: string, stopReason: "stop" | "error" = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "The provider refused the request." } : {}),
  } as unknown as AssistantMessage;
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

function gradingContext(): PluginQuestionGradingContext<ExplainBackPayload, ExplainBackAnswer> {
  return {
    chatId: "chat-fixture",
    questionId: "question-fixture",
    variant: "teach",
    contractVersion: 1,
    input: { type: "check", nodeId: "node-fixture", question: "Why is an even square divisible by 4?", payload },
    answer: { text: explanation },
    signal: new AbortController().signal,
  };
}

function scoringInference(requests: PluginInferenceRequest[], failWording = false) {
  return {
    catalog: async () => catalog(),
    complete: async (request: PluginInferenceRequest) => {
      requests.push(request);
      const systemPrompt = request.context.systemPrompt ?? "";
      if (systemPrompt === literalReaderInstructions) return reply(JSON.stringify(literalResult));
      if (systemPrompt === fixWordingInstructions) {
        if (failWording) throw new Error("The provider refused the fix wording.");
        return reply(wording);
      }
      throw new Error("Unexpected inference request.");
    },
  };
}

function fixture(options: { jev?: { endpoint?: string; timeoutMs?: number }; failWording?: boolean } = {}) {
  const dataDirectory = tempDirectory();
  const handlers = new Map<string, Handler>();
  const requests: PluginInferenceRequest[] = [];
  const events: unknown[] = [];
  let definition: PluginQuestionTypeDefinition | undefined;
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit(_topic: string, data: unknown) { events.push(data); } },
    handle(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    inference: scoringInference(requests, options.failWording),
    learning: { getSession: () => null as ChatRecord | null },
    registerQuestionType(value: typeof definition) {
      definition = value;
      return () => {};
    },
  } as unknown as PluginBackendContext, { jev: options.jev });
  assert.ok(definition?.gradeAnswer);
  return {
    grade: definition.gradeAnswer as unknown as Grade,
    handlers,
    requests,
    events,
    dataDirectory,
    cleanup,
  };
}

type JevRequest = { state: unknown; questions: Record<string, unknown> };

function jevResponse() {
  return {
    model: "jev-1.14.0",
    answers: {
      ...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: criteria[kind] }])),
      fix: {
        type: "choice",
        choice: "missing step",
        confidence: 0.64,
        probabilities: { ...criteria },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

test("saves the key in the data directory and grades through the registered grader", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevResponse()));
  const f = fixture({ jev: { endpoint: stub.url, timeoutMs: 500 } });
  try {
    assert.deepEqual(f.handlers.get("set-typesafe-key")!({ key: `  ${API_KEY}  ` }), { hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 });
    const file = path.join(f.dataDirectory, "settings.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { typesafeApiKey: API_KEY });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(f.handlers.get("get-settings")!({}), { hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 });
    assert.equal(JSON.stringify(f.handlers.get("get-settings")!({})).includes(API_KEY), false);
    assert.deepEqual(f.events, [{ hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 }]);

    const result = await f.grade(gradingContext());
    assert.deepEqual(result, {
      ...literalResult,
      scoring: {
        status: "ok",
        criteria,
        fix: { criterion: "missing step", probability: 0.82, wording },
      },
      delivery: { status: "unavailable", reason: "Interview mode is off." },
      gradedBy: "test/default-model",
    });
    const request = stub.requests[0]!.body as JevRequest;
    assert.deepEqual(request.state, {
      step: payload.step,
      premises: payload.premises,
      explanation,
      reconstruction: literalResult.reconstruction,
      gaps: literalResult.gaps,
    });
    assert.deepEqual(Object.keys(request.questions).sort(), [...GAP_KINDS, "fix"].sort());
    assert.equal(JSON.stringify(request).includes(API_KEY), false);

    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1]!.context.systemPrompt, fixWordingInstructions);
    assert.match(String(f.requests[1]!.context.messages[0]!.content), /missing step/);
    assert.equal(JSON.stringify(f.requests).includes(API_KEY), false);
    assert.equal(JSON.stringify(result).includes(API_KEY), false);
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("no key leaves the literal feedback unchanged and marks scoring unavailable", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevResponse()));
  const f = fixture({ jev: { endpoint: stub.url } });
  try {
    assert.deepEqual(f.handlers.get("get-settings")!({}), { hasTypesafeKey: false, interviewMode: false, pauseThresholdSeconds: 2 });
    const result = await f.grade(gradingContext());
    assert.deepEqual(result, {
      ...literalResult,
      scoring: { status: "unavailable", reason: "No TypeSafe API key is configured, so criterion scoring is unavailable." },
      delivery: { status: "unavailable", reason: "Interview mode is off." },
      gradedBy: "test/default-model",
    });
    assert.equal("criteria" in result.scoring, false);
    assert.equal("fix" in result.scoring, false);
    assert.equal(stub.requests.length, 0);
    assert.equal(f.requests.length, 1);
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("Jev HTTP failures preserve the reconstruction and gaps without score values", async () => {
  let status = 400;
  const stub = await stubJsonServer((_request, response) => sendJson(response, status, { detail: "failure" }));
  try {
    for (const code of [400, 429, 500, 529]) {
      status = code;
      const f = fixture({ jev: { endpoint: stub.url, timeoutMs: 500 } });
      try {
        f.handlers.get("set-typesafe-key")!({ key: API_KEY });
        const result = await f.grade(gradingContext());
        assert.equal(result.reconstruction, literalResult.reconstruction);
        assert.deepEqual(result.gaps, literalResult.gaps);
        assert.equal(result.scoring.status, "unavailable");
        assert.match(result.scoring.reason!, new RegExp(String(code)));
        assert.equal("criteria" in result.scoring, false);
        assert.equal("fix" in result.scoring, false);
        assert.equal(f.requests.length, 1);
        assert.equal(JSON.stringify(result).includes(API_KEY), false);
      } finally {
        f.cleanup();
      }
    }
  } finally {
    await stub.close();
  }
});

test("a stalled Jev request marks scoring unavailable while keeping the literal feedback", async () => {
  const stub = await stubJsonServer(() => {});
  const f = fixture({ jev: { endpoint: stub.url, timeoutMs: 25 } });
  try {
    f.handlers.get("set-typesafe-key")!({ key: API_KEY });
    const result = await f.grade(gradingContext());
    assert.equal(result.scoring.status, "unavailable");
    assert.match(result.scoring.reason!, /timed out/i);
    assert.deepEqual(result.gaps, literalResult.gaps);
    assert.equal(f.requests.length, 1);
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("a failed fix-wording call marks scoring unavailable instead of returning partial scores", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, jevResponse()));
  const f = fixture({ jev: { endpoint: stub.url, timeoutMs: 500 }, failWording: true });
  try {
    f.handlers.get("set-typesafe-key")!({ key: API_KEY });
    const result = await f.grade(gradingContext());
    assert.deepEqual(result, {
      ...literalResult,
      scoring: { status: "unavailable", reason: "The explain-back model test/default-model could not write the fix wording." },
      delivery: { status: "unavailable", reason: "Interview mode is off." },
      gradedBy: "test/default-model",
    });
  } finally {
    f.cleanup();
    await stub.close();
  }
});

test("rejects malformed keys without echoing them and accepts a replacement key", () => {
  const f = fixture();
  try {
    assert.throws(() => f.handlers.get("set-typesafe-key")!({}), /TypeSafe API key/i);
    assert.throws(() => f.handlers.get("set-typesafe-key")!({ key: "   " }), /must not be blank/i);
    assert.throws(() => f.handlers.get("set-typesafe-key")!({ key: 42 }), /TypeSafe API key/i);
    f.handlers.get("set-typesafe-key")!({ key: API_KEY });
    f.handlers.get("set-typesafe-key")!({ key: "sk-replacement" });
    const stored = fs.readFileSync(path.join(f.dataDirectory, "settings.json"), "utf8");
    assert.equal(stored.includes(API_KEY), false);
    assert.match(stored, /sk-replacement/);
  } finally {
    f.cleanup();
  }
});
