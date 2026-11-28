import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import type { PluginBackendContext, PluginQuestionTypeDefinition } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";
import { definition, readAnswer, readExplainBackResult, readPayload } from "../src/contract.ts";

const question = Compile(definition.questionSchema);
const answer = Compile(definition.answerSchema);
const validPayload = { step: "Every even square is divisible by 4.", premises: ["An even number is 2k.", "Squaring 2k gives 4k²."] };

test("activation contributes only the explain-back teach question and unregisters it", () => {
  let registered: PluginQuestionTypeDefinition | undefined;
  let unregistered = 0;
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "explain-back-contract-"));
  const cleanup = activate({
    dataDirectory,
    signal: new AbortController().signal,
    events: { emit() {} },
    handle() { return () => {}; },
    registerQuestionType(value: PluginQuestionTypeDefinition) {
      registered = value;
      return () => { unregistered++; };
    },
  } as unknown as PluginBackendContext);

  try {
    assert.ok(registered);
    const { gradeAnswer, ...rest } = registered;
    assert.equal(typeof gradeAnswer, "function");
    assert.deepEqual(rest, definition);
    assert.equal(registered.id, "explain-back");
    assert.equal(registered.label, "Explain-back check");
    assert.equal(registered.contractVersion, 1);
    assert.equal(registered.showThinking, false);
    assert.equal(registered.teach?.toolName, "explain_back");
    assert.equal("probe" in registered, false);
    assert.equal("execute" in registered, false);
    cleanup();
    assert.equal(unregistered, 1);
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("new explain-back questions require a nonblank step and nonblank premises", () => {
  assert.equal(question.Check(validPayload), true);
  assert.equal(question.Check({ step: "A step.", premises: [] }), true);
  assert.equal(question.Check({ step: "A step." }), false);
  assert.equal(question.Check({ step: "", premises: ["A premise."] }), false);
  assert.equal(question.Check({ step: "   ", premises: ["A premise."] }), false);
  assert.equal(question.Check({ step: "A step.", premises: ["  "] }), false);
  assert.equal(question.Check({ ...validPayload, extra: true }), false);
});

test("the saved answer carries nonblank explanation text", () => {
  assert.equal(answer.Check({ text: "An even number is 2k, so its square is 4k²." }), true);
  assert.equal(answer.Check({ text: "" }), false);
  assert.equal(answer.Check({ text: "   \n\t" }), false);
  assert.equal(answer.Check("A bare string."), false);
  assert.equal(answer.Check({ text: "A sentence.", extra: true }), false);
  assert.deepEqual(readAnswer({ text: "  Exact explanation.  " }), { text: "  Exact explanation.  " });
  assert.throws(() => readAnswer("A bare string."), /non-blank explanation text/i);
  assert.throws(() => readAnswer({ text: "   " }), /non-blank explanation text/i);
});

test("payload narrowing preserves the teacher's exact statements and copies the premises", () => {
  const source = { step: "  Step text.  ", premises: ["  First premise.  ", "Second premise."] };
  const read = readPayload(source);
  assert.deepEqual(read, source);
  source.premises.push("Mutated later.");
  assert.deepEqual(read.premises, ["  First premise.  ", "Second premise."]);
  assert.throws(() => readPayload({ step: "A step." }), /payload is unavailable/i);
  assert.throws(() => readPayload({ step: "A step.", premises: ["ok", 3] }), /premises must be non-blank/i);
  assert.throws(() => readPayload({ step: "", premises: [] }), /payload is unavailable/i);
});

test("saved grading results accept only the documented version, reconstruction and gap kinds", () => {
  const result = {
    version: 1,
    reconstruction: "An even number is 2k, and its square is 4k².",
    gaps: [
      { kind: "missing step", detail: "Squaring 2k gives 4k²." },
      { kind: "undefined term", detail: "k" },
      { kind: "wrong order", detail: "The square is derived before k is introduced." },
      { kind: "conclusion buried", detail: "Divisible by 4." },
    ],
  };
  assert.deepEqual(readExplainBackResult(result), result);
  assert.deepEqual(readExplainBackResult({ ...result, gaps: [] }), { ...result, gaps: [] });
  assert.equal(readExplainBackResult({ ...result, version: 2 }), null);
  assert.deepEqual(readExplainBackResult({ ...result, reconstruction: "" }), { ...result, reconstruction: "" });
  assert.equal(readExplainBackResult({ ...result, reconstruction: 3 }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: [{ kind: "missing premise", detail: "x" }] }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: [{ kind: "missing step" }] }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: "none" }), null);
  assert.equal(readExplainBackResult(null), null);
  assert.deepEqual(readExplainBackResult({ ...result, gradedBy: "claude-code/sonnet" }), { ...result, gradedBy: "claude-code/sonnet" });
  // An unreadable gradedBy is dropped, not fatal: older saves stay readable.
  assert.deepEqual(readExplainBackResult({ ...result, gradedBy: 42 }), result);
  assert.deepEqual(readExplainBackResult({ ...result, gradedBy: "   " }), result);
});

test("saved scoring accepts complete probabilities and one fix, and rejects partial shapes", () => {
  const result = { version: 1, reconstruction: "An even number is 2k.", gaps: [] };
  const criteria = { "missing step": 0.82, "undefined term": 0.11, "wrong order": 0.04, "conclusion buried": 0.27 };
  const ok = { ...result, scoring: { status: "ok", criteria, fix: { criterion: "wrong order", probability: 0.42, wording: "Say what the square depends on first." } } };
  assert.deepEqual(readExplainBackResult(ok), ok);
  const unavailable = { ...result, scoring: { status: "unavailable", reason: "Jev is unavailable (HTTP 503)." } };
  assert.deepEqual(readExplainBackResult(unavailable), unavailable);

  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, criteria: { ...criteria, "missing step": 1.2 } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, criteria: { ...criteria, "missing step": Number.NaN } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, criteria: { ...criteria, extra: 0.5 } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, fix: { ...ok.scoring.fix, criterion: "missing premise" } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, fix: { ...ok.scoring.fix, probability: -0.1 } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { ...ok.scoring, fix: { ...ok.scoring.fix, wording: "  " } } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { status: "unavailable", reason: "" } }), null);
  assert.equal(readExplainBackResult({ ...ok, scoring: { status: "maybe" } }), null);
});
