import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { PluginCleanup, PluginFrontendContext, PluginSettingsRegistration } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { SPEECH_KEY_DESCRIPTION, SPEECH_KEY_LABEL } from "../src/settings-view.ts";

type Mount = (container: HTMLElement, signal: AbortSignal) => void | PluginCleanup | Promise<void | PluginCleanup>;

type Call = { operation: string; input: unknown };

function fixture(options: { failSave?: boolean; rejectWithKey?: string } = {}) {
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