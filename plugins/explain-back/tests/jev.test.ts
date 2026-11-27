import assert from "node:assert/strict";
import { test } from "node:test";
import { GAP_KINDS, type GapKind } from "../src/contract.ts";
import { JevUnavailableError, JEV_MODEL, scoreExplainBack, type JevState } from "../src/jev.ts";
import { sendJson, stubJsonServer } from "./support/http-stub.ts";

const state: JevState = {
  step: "Every even square is divisible by 4.",
  premises: ["An even number is 2k.", "Squaring 2k gives 4k²."],
  explanation: "An even number is 2k, so its square is 4k² and divisible by 4.",
  reconstruction: "An even number is 2k, and its square is 4k².",
  gaps: [{ kind: "missing step", detail: "Squaring 2k gives 4k²." }],
};

const criteria: Record<GapKind, number> = {
  "missing step": 0.82,
  "undefined term": 0.11,
  "wrong order": 0.04,
  "conclusion buried": 0.27,
};

function responseBody(model = "jev-1.14.0", values = criteria) {
  return {
    model,
    answers: {
      ...Object.fromEntries(GAP_KINDS.map(kind => [kind, { type: "noul", noul: values[kind] }])),
      fix: {
        type: "choice",
        choice: "missing step",
        confidence: 0.64,
        probabilities: { ...values },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

test("posts the model, state and four noul questions plus one choice with Bearer auth", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, responseBody()));
  try {
    const scores = await scoreExplainBack(state, { apiKey: "typesafe-test-key", endpoint: stub.url });
    assert.equal(stub.requests.length, 1);
    const request = stub.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer typesafe-test-key");
    assert.equal(request.headers["content-type"], "application/json");
    const body = request.body as { model: string; state: JevState; questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }> };
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(body.state, state);
    assert.deepEqual(Object.keys(body.questions).sort(), [...GAP_KINDS, "fix"].sort());
    for (const kind of GAP_KINDS) {
      assert.equal(body.questions[kind]!.type, "noul");
      assert.match(body.questions[kind]!.instructions!, /\S/);
      assert.equal(body.questions[kind]!.criteria, undefined);
    }
    const fix = body.questions.fix!;
    assert.equal(fix.type, "choice");
    assert.match(fix.instructions!, /\S/);
    assert.deepEqual(Object.keys(fix.criteria!).sort(), [...GAP_KINDS].sort());

    assert.deepEqual(scores, {
      model: "jev-1.14.0",
      criteria,
      fix: { criterion: "missing step", probability: 0.82 },
    });
  } finally {
    await stub.close();
  }
});

test("parses the versioned model and ignores the request alias", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, responseBody("jev-1.14.0")));
  try {
    const scores = await scoreExplainBack(state, { apiKey: "key", endpoint: stub.url });
    assert.equal(scores.model, "jev-1.14.0");
  } finally {
    await stub.close();
  }
});

test("maps HTTP failures to safe unavailable errors without the API key", async () => {
  let status = 400;
  const stub = await stubJsonServer((_request, response) => sendJson(response, status, { detail: "Authorization header echo: typesafe-test-key" }));
  try {
    for (const code of [400, 401, 404, 429, 500, 529]) {
      status = code;
      await assert.rejects(
        scoreExplainBack(state, { apiKey: "typesafe-test-key", endpoint: stub.url }),
        (error: unknown) => {
          assert.ok(error instanceof JevUnavailableError);
          assert.match(error.message, new RegExp(String(code)));
          assert.equal(error.message.includes("typesafe-test-key"), false);
          return true;
        },
      );
    }
  } finally {
    await stub.close();
  }
});

test("a stalled Jev request becomes an unavailable error rather than hanging grading", async () => {
  const stub = await stubJsonServer(() => {});
  try {
    await assert.rejects(
      scoreExplainBack(state, { apiKey: "key", endpoint: stub.url, timeoutMs: 25 }),
      (error: unknown) => error instanceof JevUnavailableError && /timed out/i.test(error.message),
    );
  } finally {
    await stub.close();
  }
});

test("rejects unreadable responses and out-of-range probabilities", async () => {
  const cases: unknown[] = [
    {},
    { ...responseBody(), model: undefined },
    { ...responseBody(), answers: {} },
    { ...responseBody(), answers: { ...responseBody().answers, fix: { type: "choice", choice: "none", confidence: 0.5, probabilities: {} } } },
    responseBody("jev-1.14.0", { ...criteria, "missing step": 1.2 }),
    responseBody("jev-1.14.0", { ...criteria, "undefined term": Number.NaN }),
  ];
  let body: unknown = cases[0];
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, body));
  try {
    for (const candidate of cases) {
      body = candidate;
      await assert.rejects(
        scoreExplainBack(state, { apiKey: "key", endpoint: stub.url }),
        (error: unknown) => error instanceof JevUnavailableError && /unreadable/i.test(error.message),
      );
    }
  } finally {
    await stub.close();
  }
});

test("an already-aborted caller signal prevents the request", async () => {
  const stub = await stubJsonServer((_request, response) => sendJson(response, 200, responseBody()));
  try {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      scoreExplainBack(state, { apiKey: "key", endpoint: stub.url, signal: controller.signal }),
      /cancelled/,
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});
