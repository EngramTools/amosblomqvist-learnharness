import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginCleanup, PluginFrontendContext, PluginSettingsRegistration } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { readPublicSettings, SPEECH_KEY_DESCRIPTION, SPEECH_KEY_LABEL, TONEPERFECT_KEY_LABEL } from "../src/settings-view.ts";

type Mount = (container: HTMLElement, signal: AbortSignal) => void | PluginCleanup | Promise<void | PluginCleanup>;

type Call = { operation: string; input: unknown };

const unavailableAssessment = { status: "unavailable", reason: "The pronunciation assessment is unavailable." };

function nextAssessment(options: FixtureOptions): unknown {
  if (options.pendingAssessment) return options.pendingAssessment;
  if (options.assessments) return options.assessments.shift();
  return options.assessment ?? unavailableAssessment;
}

async function settingsReply(hold: FixtureOptions["holdSettings"]): Promise<unknown> {
  await hold?.until;
  if (hold?.fail) throw new Error("The settings could not be read.");
  return { configured: false, region: hold?.region ?? "", tonePerfectConfigured: false };
}

async function answer(options: FixtureOptions, operation: string): Promise<unknown> {
  if (operation === "get-settings") return settingsReply(options.holdSettings);
  if (operation === "get-coach-profile") return { targetLanguage: "en-US", firstLanguage: "en" };
  if (options.failSave) {
    throw new Error(options.rejectWithKey ? `Transport failed near ${options.rejectWithKey}` : "The settings could not be saved.");
  }
  if (operation === "assess-pronunciation") return nextAssessment(options);
  return { configured: true, region: "westus", tonePerfectConfigured: true, targetLanguage: "en-US", firstLanguage: "en" };
}

type FixtureOptions = {
  failSave?: boolean;
  rejectWithKey?: string;
  assessment?: unknown;
  /** Answers handed out in order, one per assessment call. */
  assessments?: unknown[];
  pendingAssessment?: Promise<unknown>;
  /** Holds the first get-settings reply until released, with this region. */
  holdSettings?: { until: Promise<void>; region: string; fail?: boolean };
};

function fixture(options: FixtureOptions = {}) {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const calls: Call[] = [];
  let mount: Mount | undefined;
  let notify: ((event: { topic: string; data: unknown }) => void) | undefined;
  const cleanup = activate({
    call: async (operation: string, input?: unknown) => {
      calls.push({ operation, input });
      return answer(options, operation);
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

/** A microphone stream that counts how often its track is stopped. */
function trackedStream(): { stream: MediaStream; stops: () => number } {
  let stops = 0;
  const stream = { getTracks: () => [{ stop() { stops += 1; } }] } as unknown as MediaStream;
  return { stream, stops: () => stops };
}

/** Stand in for the browser APIs the recorder needs. */
function installRecorderGlobals(options: {
  getUserMedia: () => Promise<MediaStream>;
  failClose?: boolean;
  /** Holds context.close() until released, so encoding can be observed. */
  closeGate?: Promise<void>;
  /** A context the autoplay policy keeps suspended. */
  stuckSuspended?: boolean;
}): () => void {
  const audioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const browserNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  class FakeAudioContext {
    sampleRate = 16_000;
    state = options.stuckSuspended ? "suspended" : "running";
    destination = {};
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    close() {
      if (options.closeGate) return options.closeGate;
      return options.failClose ? Promise.reject(new Error("The audio context could not be closed.")) : Promise.resolve();
    }
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

  f.notify!({ topic: "settings-changed", data: { configured: true, region: "westus", tonePerfectConfigured: false, targetLanguage: "zh-CN", firstLanguage: "en" } });
  assert.match((container.querySelector("input[type=password]") as HTMLInputElement).placeholder, /Saved key/);
  dispose();
  controller.abort();
});

test("the TonePerfect key is a separate masked field that saves backend-only", async () => {
  const { f, container, controller } = await mounted();
  const field = container.querySelector("#lh-language-coach-toneperfect-key") as HTMLInputElement;
  assert.equal(field.getAttribute("type"), "password");
  assert.match(container.textContent!, new RegExp(TONEPERFECT_KEY_LABEL));

  field.value = "toneperfect-secret";
  fire(f.document, container.querySelector("form")!, "submit");
  await settle();

  const save = f.calls.find(call => call.operation === "save-settings");
  const savedInput = save?.input;
  assert.ok(savedInput !== null && typeof savedInput === "object" && "tonePerfectKey" in savedInput);
  assert.equal(savedInput.tonePerfectKey, "toneperfect-secret");
  assert.equal(container.textContent!.includes("toneperfect-secret"), false);
  assert.equal(field.value, "");
  assert.match(field.placeholder, /Saved key/);
  controller.abort();
});

test("the frontend reads back only whether the TonePerfect key is configured", () => {
  const settings = readPublicSettings({
    configured: false,
    region: "westus",
    tonePerfectConfigured: true,
    tonePerfectKey: "toneperfect-secret",
  });
  assert.deepEqual(settings, { configured: false, region: "westus", tonePerfectConfigured: true });
});

test("a save failure never echoes the key into the status", async () => {
  const key = "speech-leaked-in-error";
  const { f, container, controller } = await mounted({ failSave: true, rejectWithKey: key });

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
  const { f, container, controller } = await mounted({}, "think");

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
  const { f, container, controller } = await mounted({ assessment: { status: "ok", scores: { accuracy: 88 }, words: [] } }, "think");

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
  const { f, container, controller } = await mounted({
    assessment: {
      status: "ok",
      scores: { accuracy: 88, fluency: 90, completeness: 95, prosody: 72 },
      words: [{ word: "think", score: 70 }],
      phonemes: [{ phoneme: "θ", score: 42, heard: ["s", "θ"] }],
    },
  }, "think");

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

test("a second Record click does not open a second microphone", async () => {
  const { f, container, controller } = await mounted({}, "think");

  let requests = 0;
  const restore = installRecorderGlobals({
    getUserMedia: async () => {
      requests += 1;
      return fakeStream();
    },
  });
  try {
    click(f.document, button(container, "Record"));
    click(f.document, button(container, "Record"));
    await settle();
    assert.equal(requests, 1);
  } finally {
    restore();
    controller.abort();
  }
});

test("leaving the settings during the permission prompt stops the microphone", async () => {
  const { f, container, controller } = await mounted({}, "think");

  const permission = Promise.withResolvers<MediaStream>();
  const microphone = trackedStream();
  const restore = installRecorderGlobals({ getUserMedia: () => permission.promise });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    controller.abort();
    permission.resolve(microphone.stream);
    await settle();
    assert.equal(microphone.stops(), 1);
  } finally {
    restore();
  }
});

test("the Record button stays disabled until the assessment completes", async () => {
  const assessment = Promise.withResolvers<unknown>();
  const { f, container, controller } = await mounted({ pendingAssessment: assessment.promise }, "think");

  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream() });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    click(f.document, button(container, "Stop"));
    await settle();

    assert.equal((button(container, "Record") as HTMLButtonElement).disabled, true);
    assessment.resolve({ status: "ok", scores: { accuracy: 88 }, words: [] });
    await settle();
    assert.equal((button(container, "Record") as HTMLButtonElement).disabled, false);
  } finally {
    restore();
    controller.abort();
  }
});

/** Mount the view, optionally with a reference text, and hand back what tests drive. */
async function mounted(options: FixtureOptions = {}, reference?: string): Promise<{ f: ReturnType<typeof fixture>; container: HTMLElement; controller: AbortController }> {
  const f = fixture(options);
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await settle();
  if (reference !== undefined) setReference(container, reference);
  return { f, container, controller };
}

function fieldValue(container: HTMLElement, id: string): string {
  return (container.querySelector(`#${id}`) as HTMLInputElement).value;
}

function fire(document: Document, element: Element, type: string): void {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  element.dispatchEvent(event);
}

test("a limit-timer finish that fails to close the context is reported, not an unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { f, container, controller } = await mounted({}, "think");
  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream(), failClose: true });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    t.mock.timers.tick(30_000);
    await settle();
    assert.match(container.textContent!, /could not be closed/);
  } finally {
    restore();
    controller.abort();
    t.mock.timers.reset();
  }
});

test("Record without reference text is refused before the microphone opens", async () => {
  const { f, container, controller } = await mounted();
  let requests = 0;
  const restore = installRecorderGlobals({ getUserMedia: async () => { requests += 1; return fakeStream(); } });
  try {
    setReference(container, "   ");
    click(f.document, button(container, "Record"));
    await settle();
    assert.equal(requests, 0);
    assert.match(container.textContent!, /Enter the reference text before recording\./);
    assert.equal((button(container, "Record") as HTMLButtonElement).disabled, false);
  } finally {
    restore();
    controller.abort();
  }
});

test("an unavailable result clears the previous attempt's scores and details", async () => {
  const { f, container, controller } = await mounted({
    assessments: [
      { status: "ok", scores: { accuracy: 88 }, words: [{ word: "think", score: 70 }] },
      { status: "unavailable", reason: "Azure could not recognise any speech in the recording." },
      "not an assessment",
    ],
  }, "think");
  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream() });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    click(f.document, button(container, "Stop"));
    await settle();
    assert.match(container.textContent!, /think — 70/);

    for (const expected of [/could not recognise any speech/, /could not be read/]) {
      click(f.document, button(container, "Record"));
      await settle();
      click(f.document, button(container, "Stop"));
      await settle();
      assert.match(container.textContent!, expected);
      assert.equal(container.textContent!.includes("think — 70"), false);
      assert.equal(container.querySelectorAll(".lh-language-coach-settings__details li").length, 0);
    }
  } finally {
    restore();
    controller.abort();
  }
});

test("the status moves from Recording to encoding to assessing once capture stops", async () => {
  const closeGate = Promise.withResolvers<void>();
  const assessment = Promise.withResolvers<unknown>();
  const { f, container, controller } = await mounted({ pendingAssessment: assessment.promise }, "think");
  const restore = installRecorderGlobals({ getUserMedia: async () => fakeStream(), closeGate: closeGate.promise });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    assert.match(container.textContent!, /Recording…/);
    click(f.document, button(container, "Stop"));
    await settle();
    assert.match(container.textContent!, /Encoding the recording…/);
    assert.equal(container.textContent!.includes("Recording…"), false);
    closeGate.resolve();
    await settle();
    assert.match(container.textContent!, /Assessing pronunciation…/);
    assessment.resolve({ status: "ok", scores: { accuracy: 88 }, words: [] });
    await settle();
    assert.match(container.textContent!, /Accuracy 88/);
  } finally {
    restore();
    controller.abort();
  }
});

test("a context the browser keeps suspended shows a readable error and releases the microphone", async () => {
  const { f, container, controller } = await mounted({}, "think");
  const microphone = trackedStream();
  const restore = installRecorderGlobals({ getUserMedia: async () => microphone.stream, stuckSuspended: true });
  try {
    click(f.document, button(container, "Record"));
    await settle();
    assert.match(container.textContent!, /kept audio capture paused/);
    assert.equal(microphone.stops() >= 1, true);
    assert.equal((button(container, "Record") as HTMLButtonElement).disabled, false);
  } finally {
    restore();
    controller.abort();
  }
});

test("a late initial load does not overwrite what the learner typed", async () => {
  const hold = Promise.withResolvers<void>();
  const { f, container, controller } = await mounted({ holdSettings: { until: hold.promise, region: "stale-region" } });
  const region = container.querySelector("#lh-language-coach-region") as HTMLInputElement;
  region.value = "eastus";
  fire(f.document, region, "input");
  hold.resolve();
  await settle();
  assert.equal(fieldValue(container, "lh-language-coach-region"), "eastus");
  controller.abort();
});

test("a late initial load does not revert values the learner just saved", async () => {
  const hold = Promise.withResolvers<void>();
  const { f, container, controller } = await mounted({ holdSettings: { until: hold.promise, region: "stale-region" } });
  fire(f.document, container.querySelector("form")!, "submit");
  await settle();
  assert.equal(fieldValue(container, "lh-language-coach-region"), "westus");
  hold.resolve();
  await settle();
  assert.equal(fieldValue(container, "lh-language-coach-region"), "westus");
  controller.abort();
});

test("an initial load that arrives first still fills the form", async () => {
  const { container, controller } = await mounted({ holdSettings: { until: Promise.resolve(), region: "northeurope" } });
  await settle();
  assert.equal(fieldValue(container, "lh-language-coach-region"), "northeurope");
  controller.abort();
});

test("a failed late initial load does not replace the saved status", async () => {
  const hold = Promise.withResolvers<void>();
  const { f, container, controller } = await mounted({ holdSettings: { until: hold.promise, region: "", fail: true } });
  fire(f.document, container.querySelector("form")!, "submit");
  await settle();
  hold.resolve();
  await settle();
  assert.equal(container.textContent!.includes("could not be read"), false);
  controller.abort();
});
