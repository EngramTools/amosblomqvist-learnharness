import assert from "node:assert/strict";
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
  const cleanup = activate({
    registerQuestionType(value: PluginQuestionTypeDefinition) {
      registered = value;
      return () => { unregistered++; };
    },
  } as unknown as PluginBackendContext);

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
  assert.equal(readExplainBackResult({ ...result, reconstruction: "  " }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: [{ kind: "missing premise", detail: "x" }] }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: [{ kind: "missing step" }] }), null);
  assert.equal(readExplainBackResult({ ...result, gaps: "none" }), null);
  assert.equal(readExplainBackResult(null), null);
});
