import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginFrontendContext, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginQuestionMountContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import type { ExplainBackAnswer, ExplainBackPayload } from "../src/contract.ts";

type Renderer = PluginQuestionRenderer<ExplainBackPayload, ExplainBackAnswer>;

function fixture() {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const markdowns: string[] = [];
  let renderer: Renderer | undefined;
  const ui = {
    mountMarkdown(container: HTMLElement, props: { text: string }) {
      markdowns.push(props.text);
      const node = container.ownerDocument.createElement("div");
      node.className = "fixture-markdown";
      node.textContent = props.text;
      container.append(node);
      return { update(next: { text: string }) { node.textContent = next.text; }, dispose() { node.remove(); } };
    },
  };
  const cleanup = activate({
    ui,
    registerQuestionRenderer(value: Renderer) {
      renderer = value;
      return () => { renderer = undefined; };
    },
    registerSettings() {
      return () => {};
    },
  } as unknown as PluginFrontendContext);
  return { document, markdowns, renderer: renderer!, cleanup };
}

const payload: ExplainBackPayload = {
  step: "Every even square is divisible by 4.",
  premises: ["An even number is 2k.", "Squaring 2k gives 4k²."],
};

function mountContext(signal: AbortSignal): PluginQuestionMountContext<ExplainBackPayload> {
  return {
    input: { question: "Explain the step back in your own words.", type: "check", nodeId: "node-1", payload },
    chatId: "chat-1",
    questionId: "question-1",
    contractVersion: 1,
    variant: "teach",
    signal,
  };
}

function editorFixture(signal: AbortSignal) {
  const states: Parameters<PluginQuestionEditorProps<ExplainBackPayload>["onChange"]>[0][] = [];
  const props: PluginQuestionEditorProps<ExplainBackPayload> = {
    ...mountContext(signal),
    active: true,
    answer: { status: "empty" },
    onChange(state) { states.push(state); },
  };
  return { props, states };
}

test("the pending question shows the prompt, the step and every premise", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  const dispose = f.renderer.mountQuestion!(container, mountContext(controller.signal)) as () => void;

  const text = container.textContent!;
  assert.match(text, /Explain the step back in your own words\./);
  assert.match(text, /Every even square is divisible by 4\./);
  assert.match(text, /An even number is 2k\./);
  assert.match(text, /Squaring 2k gives 4k²\./);
  assert.equal(f.markdowns.length, 4);
  controller.abort();
  assert.equal(container.textContent, "");
  dispose();
});

test("the free-text editor publishes readiness, appends dictation as text, and applies controlled updates", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  const { props, states } = editorFixture(controller.signal);
  const handle = f.renderer.mountAnswerEditor(container, props) as PluginQuestionEditorHandle;

  const textarea = container.querySelector("textarea")!;
  assert.equal(textarea.getAttribute("aria-label"), "Your explanation");
  assert.equal(textarea.readOnly, false);
  assert.deepEqual(states.at(-1), { status: "empty" });

  textarea.value = "An even number is 2k.";
  const input = f.document.createEvent("Event");
  input.initEvent("input");
  textarea.dispatchEvent(input);
  assert.deepEqual(states.at(-1), { status: "ready", value: { text: "An even number is 2k." } });

  handle.appendTranscript!("Its square is 4k².");
  assert.equal(textarea.value, "An even number is 2k. Its square is 4k².");
  assert.deepEqual(states.at(-1), { status: "ready", value: { text: "An even number is 2k. Its square is 4k²." } });

  handle.update({ answer: { status: "ready", value: { text: "Replacement text." } }, active: false });
  assert.equal(textarea.value, "Replacement text.");
  assert.equal(textarea.readOnly, true);
  handle.appendTranscript!(" More dictation.");
  assert.equal(textarea.value, "Replacement text. More dictation.");
  assert.deepEqual(states.at(-1), { status: "ready", value: { text: "Replacement text. More dictation." } });

  handle.focus();
  handle.dispose();
  assert.equal(container.textContent, "");
});

test("the answered card shows the saved explanation, reconstruction and labelled gaps", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal),
    answer: { text: "An even number is 2k, so its square is divisible by 4." },
    grading: {
      result: {
        version: 1,
        reconstruction: "An even number is 2k, and its square is 4k².",
        gaps: [
          { kind: "missing step", detail: "Squaring 2k gives 4k²." },
          { kind: "conclusion buried", detail: "Divisible by 4." },
        ],
      },
    },
  });

  const text = container.textContent!;
  assert.match(text, /Your explanation/);
  assert.match(text, /An even number is 2k, so its square is divisible by 4\./);
  assert.match(text, /What a literal reader understood/);
  assert.match(text, /An even number is 2k, and its square is 4k²\./);
  assert.match(text, /Missing step/);
  assert.match(text, /Squaring 2k gives 4k²\./);
  assert.match(text, /Conclusion buried/);
  assert.match(text, /Divisible by 4\./);
  assert.equal(container.querySelectorAll("[data-gap-kind]").length, 2);
  controller.abort();
  assert.equal(container.textContent, "");
});

test("an empty reconstruction shows a placeholder and still lists the gaps", () => {
  const f = fixture();
  for (const reconstruction of ["", "  \n "]) {
    const container = f.document.createElement("div");
    f.document.body.append(container);
    const controller = new AbortController();
    f.renderer.mountAnswered!(container, {
      ...mountContext(controller.signal),
      answer: { text: "Something about evens." },
      grading: { result: { version: 1, reconstruction, gaps: [{ kind: "missing step", detail: "Squaring 2k gives 4k²." }] } },
    });

    const section = container.querySelector(".lh-explain-back__reconstruction")!;
    assert.match(section.textContent!, /What a literal reader understood/);
    assert.match(section.textContent!, /Nothing could be reconstructed from the explanation\./);
    assert.equal(section.querySelectorAll("p").length, 1);
    assert.equal(container.querySelectorAll("[data-gap-kind]").length, 1);
    assert.match(container.textContent!, /Squaring 2k gives 4k²\./);
    controller.abort();
  }
});

test("a grading error is shown readably and an unreadable saved result falls back to the error state", () => {
  const f = fixture();
  const failed = f.document.createElement("div");
  const invalid = f.document.createElement("div");
  f.document.body.append(failed, invalid);
  const first = new AbortController();
  const second = new AbortController();
  f.renderer.mountAnswered!(failed, {
    ...mountContext(first.signal),
    answer: { text: "An even number is 2k." },
    grading: { error: "Provider connection failed." },
  });
  assert.match(failed.textContent!, /Your answer was saved/);
  assert.match(failed.textContent!, /Provider connection failed\./);
  assert.match(failed.textContent!, /Feedback unavailable/);

  f.renderer.mountAnswered!(invalid, {
    ...mountContext(second.signal),
    answer: { text: "An even number is 2k." },
    grading: { result: { version: 1, reconstruction: "x", gaps: [{ kind: "not a kind", detail: "x" }] } },
  });
  assert.match(invalid.textContent!, /saved feedback could not be read/i);
  first.abort();
  second.abort();
  assert.equal(failed.textContent, "");
  assert.equal(invalid.textContent, "");
});

test("the answered card shows every criterion probability and the single fix", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal),
    answer: { text: "An even number is 2k, so its square is divisible by 4." },
    grading: {
      result: {
        version: 1,
        reconstruction: "An even number is 2k, and its square is 4k².",
        gaps: [{ kind: "missing step", detail: "Squaring 2k gives 4k²." }],
        scoring: {
          status: "ok",
          criteria: { "missing step": 0.82, "undefined term": 0.11, "wrong order": 0.04, "conclusion buried": 0.27 },
          fix: { criterion: "missing step", probability: 0.82, wording: "Say that squaring 2k gives 4k² before concluding divisibility." },
        },
      },
    },
  });

  const text = container.textContent!;
  assert.match(text, /Criterion probabilities/);
  assert.match(text, /Missing step/);
  assert.match(text, /82%/);
  assert.match(text, /Undefined term/);
  assert.match(text, /11%/);
  assert.match(text, /Wrong order/);
  assert.match(text, /4%/);
  assert.match(text, /Conclusion buried/);
  assert.match(text, /27%/);
  assert.match(text, /Fix for next time/);
  assert.match(text, /Say that squaring 2k gives 4k² before concluding divisibility\./);
  assert.equal(container.querySelectorAll("[data-criterion]").length, 4);
  assert.equal(container.querySelector(".lh-explain-back__fix")?.getAttribute("data-fix-criterion"), "missing step");
  controller.abort();
  assert.equal(container.textContent, "");
});

test("unavailable scoring shows only the reason and keeps the reconstruction and gaps", () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.renderer.mountAnswered!(container, {
    ...mountContext(controller.signal),
    answer: { text: "An even number is 2k." },
    grading: {
      result: {
        version: 1,
        reconstruction: "An even number is 2k.",
        gaps: [{ kind: "missing step", detail: "Squaring 2k gives 4k²." }],
        scoring: { status: "unavailable", reason: "Jev is rate limiting requests (HTTP 429)." },
      },
    },
  });

  const text = container.textContent!;
  assert.match(text, /What a literal reader understood/);
  assert.match(text, /An even number is 2k\./);
  assert.match(text, /Squaring 2k gives 4k²\./);
  assert.match(text, /Scoring unavailable/);
  assert.match(text, /Jev is rate limiting requests \(HTTP 429\)\./);
  assert.equal(container.querySelectorAll("[data-criterion]").length, 0);
  assert.equal(container.querySelectorAll("[data-fix-criterion]").length, 0);
  controller.abort();
});
