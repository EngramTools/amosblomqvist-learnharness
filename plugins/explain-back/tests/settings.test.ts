import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginCleanup, PluginFrontendContext, PluginSettingsRegistration } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { TYPESAFE_KEY_DESCRIPTION, TYPESAFE_KEY_LABEL } from "../src/settings-view.ts";

type Mount = (container: HTMLElement, signal: AbortSignal) => void | PluginCleanup | Promise<void | PluginCleanup>;

type Call = { operation: string; input: unknown };

function fixture(options: { failSave?: boolean; rejectWithKey?: string } = {}) {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const calls: Call[] = [];
  let mount: Mount | undefined;
  let notify: ((event: { topic: string; data: unknown }) => void) | undefined;
  let rendererRegistered = false;
  let settingsCleanup: (() => void) | undefined;
  const cleanup = activate({
    call: async (operation: string, input?: unknown) => {
      calls.push({ operation, input });
      if (operation === "get-settings") return { hasTypesafeKey: false, interviewMode: false, pauseThresholdSeconds: 2 };
      if (options.failSave) {
        throw new Error(options.rejectWithKey ? `Transport failed near ${options.rejectWithKey}` : "The key could not be saved.");
      }
      return { hasTypesafeKey: true, interviewMode: false, pauseThresholdSeconds: 2 };
    },
    onNotification(listener: (event: { topic: string; data: unknown }) => void) {
      notify = listener;
      return () => { notify = undefined; };
    },
    registerQuestionRenderer() {
      rendererRegistered = true;
      return () => {};
    },
    registerSettings(registration: PluginSettingsRegistration) {
      if (typeof registration === "function") mount = registration;
      else if (registration && typeof registration === "object" && "mount" in registration) mount = registration.mount as Mount;
      else throw new Error("Unexpected settings registration.");
      settingsCleanup = () => {};
      return settingsCleanup;
    },
  } as unknown as PluginFrontendContext);
  return {
    document,
    calls,
    get mount() { return mount; },
    get notify() { return notify; },
    rendererRegistered,
    cleanup,
  };
}

async function flush(): Promise<void> {
  for (let pending = 0; pending < 5; pending++) await Promise.resolve();
}

test("activation registers the question renderer and the TypeSafe settings mount", () => {
  const f = fixture();
  assert.equal(f.rendererRegistered, true);
  assert.equal(typeof f.mount, "function");
  f.cleanup();
});

test("the settings row masks the key, states the data sharing, and never renders the saved key", async () => {
  const f = fixture();
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  const dispose = f.mount!(container, controller.signal) as () => void;
  await flush();

  const input = container.querySelector("input[type=password]") as HTMLInputElement;
  assert.equal(input.getAttribute("type"), "password");
  assert.equal(input.value, "");
  assert.match(container.textContent!, new RegExp(TYPESAFE_KEY_LABEL));
  assert.match(container.textContent!, new RegExp(TYPESAFE_KEY_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(container.textContent!, /Learner text is sent to TypeSafe/);
  assert.deepEqual(f.calls[0], { operation: "get-settings", input: undefined });

  input.value = "sk-settings-secret";
  const submit = f.document.createEvent("Event");
  submit.initEvent("submit", true, true);
  container.querySelector("form")!.dispatchEvent(submit);
  await flush();

  assert.deepEqual(f.calls[1], { operation: "set-typesafe-key", input: { key: "sk-settings-secret" } });
  assert.deepEqual(f.calls.slice(2), [
    { operation: "set-interview-mode", input: { mode: false } },
    { operation: "set-pause-threshold", input: { seconds: 2 } },
  ]);
  assert.equal(input.value, "");
  assert.match(container.textContent!, /Saved\. Learner text is sent to TypeSafe for scoring\./);
  assert.equal(container.textContent!.includes("sk-settings-secret"), false);

  f.notify!({ topic: "settings-changed", data: { hasTypesafeKey: true } });
  assert.match(container.textContent!, /Replace key/);
  dispose();
  assert.equal(container.textContent, "");
  assert.equal(f.notify, undefined);
});

test("a save failure never echoes the key into the status", async () => {
  const key = "sk-leaked-in-error";
  const f = fixture({ failSave: true, rejectWithKey: key });
  const container = f.document.createElement("div");
  f.document.body.append(container);
  const controller = new AbortController();
  f.mount!(container, controller.signal);
  await flush();

  const input = container.querySelector("input") as HTMLInputElement;
  input.value = key;
  const submit = f.document.createEvent("Event");
  submit.initEvent("submit", true, true);
  container.querySelector("form")!.dispatchEvent(submit);
  await flush();

  assert.match(container.textContent!, /The key could not be saved\./);
  assert.equal(container.textContent!.includes(key), false);
  controller.abort();
});
