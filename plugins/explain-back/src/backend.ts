import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition } from "./contract.ts";
import { gradeExplainBack, type JevRuntime } from "./grader.ts";

export type ExplainBackBackendOptions = {
  /** Test-only transport override; the host always activates without it. */
  jev?: JevRuntime;
};

type Settings = { typesafeApiKey?: string };

type PublicSettings = { hasTypesafeKey: boolean };

const settingsFile = (directory: string) => path.join(directory, "settings.json");

function loadSettings(directory: string): Settings {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(settingsFile(directory), "utf8"));
    if (!record(value) || typeof value.typesafeApiKey !== "string") return {};
    const key = value.typesafeApiKey.trim();
    return key ? { typesafeApiKey: key } : {};
  } catch {
    // Scoring is optional: an absent or unreadable key store means no key.
    return {};
  }
}

function saveKey(directory: string, key: string): void {
  const file = settingsFile(directory);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ typesafeApiKey: key }) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function publicSettings(settings: Settings): PublicSettings {
  return { hasTypesafeKey: Boolean(settings.typesafeApiKey) };
}

/** Never echo the key, including from validation and transport failures. */
function readKey(input: unknown): string {
  if (!record(input) || typeof input.key !== "string") throw new Error("Expected a TypeSafe API key.");
  const key = input.key.trim();
  if (!key) throw new Error("The TypeSafe API key must not be blank.");
  if (key.length > 4096) throw new Error("The TypeSafe API key is too long.");
  return key;
}

export function activate(ctx: PluginBackendContext, options: ExplainBackBackendOptions = {}): () => void {
  const settings = loadSettings(ctx.dataDirectory);
  let disposed = false;
  const assertActive = () => {
    if (disposed || ctx.signal.aborted) throw new Error("Explain-back is disabled.");
  };
  const get = ctx.handle("get-settings", () => {
    assertActive();
    return publicSettings(settings);
  });
  const set = ctx.handle("set-typesafe-key", input => {
    assertActive();
    const key = readKey(input);
    saveKey(ctx.dataDirectory, key);
    settings.typesafeApiKey = key;
    const published = publicSettings(settings);
    ctx.events.emit("settings-changed", published);
    return published;
  });
  let unregister: () => void;
  try {
    unregister = ctx.registerQuestionType({
      ...definition,
      gradeAnswer: context => gradeExplainBack(ctx, context, {
        readTypesafeKey: () => settings.typesafeApiKey,
        jev: options.jev,
      }),
    });
  } catch (error) {
    get(); set();
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    unregister(); get(); set();
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
