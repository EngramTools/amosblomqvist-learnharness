import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginCleanup, PluginFrontendContext, PluginSettingsRegistration } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { SPEECH_KEY_DESCRIPTION, SPEECH_KEY_LABEL } from "../src/settings-view.ts";

type Mount = (container: HTMLElement, signal: AbortSignal) => void | PluginCleanup | Promise<void | PluginCleanup>;

type Call = { operation: string; input: unknown };

function fixture(options: { failSave?: boolean; rejectWithKey?: string; assessment?: unknown } = {}) {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const calls: Call[] = [];
  let mount: Mount | undefined;
  let notify: ((event: { topic: string; data: unknown }) => void) | undefined;
  const cleanup = activate({
    call: async (operation: string, input?: unknown) => {
      calls.push({ operation, input });
      if (operation === "get-settings") return { configured: false, region: "" };
      if (operation === "get-coach-profile") return { targetLanguage: "en-US", firstLanguage: "en" };
      if (options.failSave) {
        throw new Error(options.rejectWithKey ? `Transport failed near ${options.rejectWithKey}` : "The settings could not be saved.");
      }
      if (operation === "assess-pronunciation") return options.assessment ?? { status: "unavailable", reason: "The pronunciation assessment is unavailable." };
      return { configured: true, region: "westus", targetLanguage: "en-US", firstLanguage: "en" };
    },
    onNotification(listener: (event: { topic: string; data: unknown }) => void) {
      notify = listener;
      return () => { notify = undefined; };
    },
    registerSettings(registration: PluginSettingsRegistration) {
      if (typeof registration === "function") mount = registration;
      else if (registration && typeof registration === "object" && "mount" in registration) mount = registration.mount as Mount;
      else throw new Error("Unexpected settings registration.");
      return () => {};
    },
  } as unknown as PluginFrontendContext);
  return { document, calls, get mount() { return mount; }, get notify() { return notify; }, cleanup };
}

async function flush(): Promise<void> {
  for (let pending = 0; pending < 5; pending++) await Promise.resolve();
}

/** Drain the promise chain of the view, including awaited recorder work. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

function button(container: HTMLElement, label: string): Element {
  const found = Array.from(container.querySelectorAll("button")).find(item => item.textContent === label);
  assert.ok(found, `The ${label} button is missing.`);
  return found!;
}

function click(document: Document, element: Element): void {
  const event = document.createEvent("Event");
  event.initEvent("click", true, true);
  element.dispatchEvent(event);
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
}

/** Stand in for the browser APIs the recorder needs. */
function installRecorderGlobals(options: { getUserMedia: () => Promise<MediaStream>; failClose?: boolean }): () => void {
  const audioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const browserNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  class FakeAudioContext {
    sampleRate = 16_000;
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    close() { return options.failClose ? Promise.reject(new Error("The audio context could not be closed.")) : Promise.resolve(); }
  }
  Object.defineProperty(globalThis, "AudioContext", { value: FakeAudioContext, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: options.getUserMedia } },
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "AudioContext", audioContext ?? { value: undefined, configurable: true, writable: true });
    if (browserNavigator) Object.defineProperty(globalThis, "navigator", browserNavigator);
  };
}

test("activation registers the settings mount", () => {
  const f = fixture();
  assert.equal(typeof f.mount, "function");
  f.cleanup();
});

test("the settings row masks the key and exposes only configured and region", async () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  const dispose = f.mount!(container, controller.signal) as () => void;
  await flush();

  const input = container.querySelector("input[type=password]") as HTMLInputElement;
  assert.equal(input.getAttribute("type"), "password");
  assert.equal(input.value, "");
  assert.match(container.textContent!, new RegExp(SPEECH_KEY_LABEL));
  assert.match(container.textContent!, new RegExp(SPEECH_KEY_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(f.calls[0], { operation: "get-settings", input: undefined });
  assert.deepEqual(f.calls[1], { operation: "get-coach-profile", input: undefined });

  input.value = "speech-secret";
  (container.querySelector("#lh-language-coach-region") as HTMLInputElement).value = "westus";
  const submit = f.document.createEvent("Event");
  submit.initEvent("submit", true, true);
  container.querySelector("form")!.dispatchEvent(submit);
  await flush();

  assert.deepEqual(f.calls[2]?.operation, "save-settings");
  assert.equal((f.calls[2]?.input as { key?: string }).key, "speech-secret");
  assert.equal(container.textContent!.includes("speech-secret"), false);

  f.notify!({ topic: "settings-changed", data: { configured: true, region: "westus", targetLanguage: "zh-CN", firstLanguage: "en" } });
  assert.match((container.querySelector("input[type=password]") as HTMLInputElement).placeholder, /Saved key/);
  dispose();
  controller.abort();
});

test("a save failure never echoes the key into the status", async () => {
  const key = "speech-leaked-in-error";
  const f = fixture({ failSave: true, rejectWithKey: key });
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await flush();

  const input = container.querySelector("input[type=password]") as HTMLInputElement;
  input.value = key;
  (container.querySelector("#lh-language-coach-region") as HTMLInputElement).value = "westus";
  const submit = f.document.createEvent("Event");
  submit.initEvent("submit", true, true);
  container.querySelector("form")!.dispatchEvent(submit);
  await flush();

  assert.match(container.textContent!, /The settings could not be saved\./);
  assert.equal(container.textContent!.includes(key), false);
  controller.abort();
});

function setReference(container: HTMLElement, text: string): void {
  const input = container.querySelector('input[placeholder="Reference text to read aloud"]') as HTMLInputElement;
  assert.ok(input, "The reference text input is missing.");
  input.value = text;
}

test("a failed stop leaves the recorder ready for another recording", async () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await flush();

  let requests = 0;
  const restore = installRecorderGlobals({
    getUserMedia: async () => {
      requests += 1;
      return fakeStream();
    },
    failClose: true,
  });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    assert.equal(requests, 1);

    click(f.document, button(container, "Stop"));
    await settle();
    assert.match(container.textContent!, /could not be closed/);

    click(f.document, button(container, "Record"));
    await settle();
    assert.equal(requests, 2);
  } finally {
    restore();
    controller.abort();
  }
});

test("the recording limit ends the clip and assesses it without pressing Stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ assessment: { status: "ok", scores: { accuracy: 88 }, words: [] } });
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await flush();
  setReference(container, "think");

  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream() });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    assert.equal(f.calls.some(call => call.operation === "assess-pronunciation"), false);

    t.mock.timers.tick(30_000);
    await settle();
    assert.equal(f.calls.some(call => call.operation === "assess-pronunciation"), true);
    assert.match(container.textContent!, /Accuracy 88/);
  } finally {
    restore();
    controller.abort();
    t.mock.timers.reset();
  }
});

test("the assessment result shows the mapped scores and pronunciation details", async () => {
  const f = fixture({
    assessment: {
      status: "ok",
      scores: { accuracy: 88, fluency: 90, completeness: 95, prosody: 72 },
      words: [{ word: "think", score: 70 }],
      phonemes: [{ phoneme: "θ", score: 42, heard: ["s", "θ"] }],
    },
  });
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await flush();
  setReference(container, "think");

  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream() });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    click(f.document, button(container, "Stop"));
    await settle();

    assert.match(container.textContent!, /Assessment received\. Accuracy 88, Fluency 90, Completeness 95, Prosody 72\./);
    assert.match(container.textContent!, /think — 70/);
    assert.match(container.textContent!, /θ — 42 \(heard: s, θ\)/);
  } finally {
    restore();
    controller.abort();
  }
});