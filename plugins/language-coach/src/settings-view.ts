import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { CoachLocale } from "./judge-types.ts";
import { assessmentLines, assessmentSummary } from "./assessment-details.ts";
import { RECORDING_LIMIT_MS } from "./recorder.ts";
import { createRecordingFlow } from "./recording-flow.ts";
import { button, note, passwordField, selectField, textField } from "./settings-fields.ts";

type SettingsContext = Pick<PluginFrontendContext, "call" | "onNotification">;

type LabeledInput<T extends HTMLInputElement | HTMLSelectElement> = {
  field: HTMLLabelElement;
  input: T;
};

type FormFields = {
  key: LabeledInput<HTMLInputElement>;
  tonePerfectKey: LabeledInput<HTMLInputElement>;
  region: LabeledInput<HTMLInputElement>;
  target: LabeledInput<HTMLSelectElement>;
  first: LabeledInput<HTMLInputElement>;
};

type FormUi = {
  form: HTMLFormElement;
  fields: FormFields;
  save: HTMLButtonElement;
  status: HTMLParagraphElement;
};

export type PublicSettings = {
  configured: boolean;
  region: string;
  tonePerfectConfigured: boolean;
};

export type CoachProfile = {
  targetLanguage: CoachLocale;
  firstLanguage: string;
};

export const SPEECH_KEY_LABEL = "Azure Speech key";
export const SPEECH_KEY_DESCRIPTION = "Recorded clips are sent to Azure for pronunciation assessment. The key is stored in this plugin's data directory and is never shown in full.";
export const TONEPERFECT_KEY_LABEL = "TonePerfect key";
export const TONEPERFECT_KEY_DESCRIPTION = "Mandarin clips are sent to TonePerfect for tone assessment when a key is saved. The key is stored in this plugin's data directory and is never shown in full.";
export const REGION_LABEL = "Azure Speech region";
export const TARGET_LANGUAGE_LABEL = "Target language";
export const FIRST_LANGUAGE_LABEL = "Learner first language";

const SAVE_FAILED = "The settings could not be saved.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPublicSettings(value: Record<string, unknown>): value is PublicSettings {
  return typeof value.configured === "boolean"
    && typeof value.region === "string"
    && typeof value.tonePerfectConfigured === "boolean";
}

function isLocale(value: unknown): value is CoachLocale {
  return value === "en-US" || value === "zh-CN";
}

export function readPublicSettings(value: unknown): PublicSettings {
  const entry = record(value) ? value : {};
  if (!isPublicSettings(entry)) throw new Error("Language coach settings are unavailable.");
  return { configured: entry.configured, region: entry.region, tonePerfectConfigured: entry.tonePerfectConfigured };
}

export function readCoachProfile(value: unknown): CoachProfile {
  const entry = record(value) ? value : {};
  const { targetLanguage, firstLanguage } = entry;
  if (!isLocale(targetLanguage) || typeof firstLanguage !== "string") throw new Error("Language coach profile is unavailable.");
  return { targetLanguage, firstLanguage };
}

/** Never echo a key, including from validation and transport failures. */
function failureMessage(error: unknown, ...keys: string[]): string {
  const message = error instanceof Error ? error.message : SAVE_FAILED;
  return keys.some(key => key && message.includes(key)) ? SAVE_FAILED : message;
}

/** Run `onEdit` whenever the learner touches one of the inputs. */
function watchEdits(inputs: (HTMLInputElement | HTMLSelectElement)[], onEdit: () => void): void {
  for (const input of inputs) {
    input.addEventListener("input", onEdit);
    input.addEventListener("change", onEdit);
  }
}

function buildForm(document: Document): FormUi {
  const fields = {
    key: passwordField(document, SPEECH_KEY_LABEL, "lh-language-coach-key"),
    tonePerfectKey: passwordField(document, TONEPERFECT_KEY_LABEL, "lh-language-coach-toneperfect-key"),
    region: textField(document, REGION_LABEL, "lh-language-coach-region", "westus"),
    target: selectField(document, TARGET_LANGUAGE_LABEL, "lh-language-coach-target", [
      { value: "en-US", label: "English (en-US)" },
      { value: "zh-CN", label: "Mandarin (zh-CN)" },
    ]),
    first: textField(document, FIRST_LANGUAGE_LABEL, "lh-language-coach-first", "en"),
  };
  const form = document.createElement("form");
  form.className = "lh-language-coach-settings__form";
  const actions = document.createElement("div");
  actions.className = "lh-language-coach-settings__actions";
  const save = button(document, "submit", "Save settings");
  actions.append(save);
  const status = document.createElement("p");
  status.className = "lh-language-coach-settings__status";
  status.setAttribute("role", "status");
  form.append(
    fields.key.field,
    note(document, SPEECH_KEY_DESCRIPTION),
    fields.tonePerfectKey.field,
    note(document, TONEPERFECT_KEY_DESCRIPTION),
    fields.region.field,
    fields.target.field,
    fields.first.field,
    actions,
    status,
  );
  return { form, fields, save, status };
}

function buildRecorder(document: Document) {
  const section = document.createElement("section");
  section.className = "lh-language-coach-settings__recorder";
  const title = document.createElement("h3");
  title.textContent = "Record a clip";
  const reference = document.createElement("input");
  reference.type = "text";
  reference.placeholder = "Reference text to read aloud";
  reference.className = "lh-language-coach-settings__input";
  const record = button(document, "button", "Record");
  const stop = button(document, "button", "Stop");
  stop.disabled = true;
  const details = document.createElement("ul");
  details.className = "lh-language-coach-settings__details";
  const limitNote = note(document, `Recording stops automatically after ${RECORDING_LIMIT_MS / 1000} seconds.`);
  section.append(title, reference, record, stop, limitNote, details);
  return { section, reference, record, stop, details };
}

function applyPublicSettings(fields: FormFields, settings: PublicSettings, profile: CoachProfile): void {
  fields.key.input.placeholder = settings.configured ? "Saved key — enter a new key to replace it" : "Paste an Azure Speech key";
  fields.tonePerfectKey.input.placeholder = settings.tonePerfectConfigured
    ? "Saved key — enter a new key to replace it"
    : "Paste a TonePerfect key";
  fields.region.input.value = settings.region;
  fields.target.input.value = profile.targetLanguage;
  fields.first.input.value = profile.firstLanguage;
}

function settingsPayload(fields: FormFields, key: string, tonePerfectKey: string): Record<string, string> {
  return {
    region: fields.region.input.value,
    targetLanguage: fields.target.input.value,
    firstLanguage: fields.first.input.value,
    ...(key ? { key } : {}),
    ...(tonePerfectKey ? { tonePerfectKey } : {}),
  };
}

function setFieldsDisabled(fields: FormFields, save: HTMLButtonElement, disabled: boolean): void {
  fields.key.input.disabled = disabled;
  fields.tonePerfectKey.input.disabled = disabled;
  save.disabled = disabled;
}

type SaveDeps = {
  ctx: SettingsContext;
  fields: FormFields;
  save: HTMLButtonElement;
  isLive: () => boolean;
  markNewer: () => void;
  setStatus: (message: string, error?: boolean) => void;
};

async function saveCoachSettings(deps: SaveDeps, keys: { key: string; tonePerfectKey: string }): Promise<void> {
  const saved = await deps.ctx.call("save-settings", settingsPayload(deps.fields, keys.key, keys.tonePerfectKey));
  const settings = readPublicSettings(saved);
  const profile = readCoachProfile(saved);
  if (!deps.isLive()) return;
  if (keys.key) deps.fields.key.input.value = "";
  if (keys.tonePerfectKey) deps.fields.tonePerfectKey.input.value = "";
  deps.markNewer();
  applyPublicSettings(deps.fields, settings, profile);
  deps.setStatus(keys.key ? "Saved. Clips are sent to Azure for pronunciation assessment." : "Saved.");
}

/** One save at a time; a failed save leaves the form ready for another attempt. */
function createSubmitHandler(deps: SaveDeps): (event: Event) => Promise<void> {
  let busy = false;
  return async event => {
    event.preventDefault();
    if (busy || !deps.isLive()) return;
    busy = true;
    const key = deps.fields.key.input.value.trim();
    const tonePerfectKey = deps.fields.tonePerfectKey.input.value.trim();
    setFieldsDisabled(deps.fields, deps.save, true);
    try {
      await saveCoachSettings(deps, { key, tonePerfectKey });
    } catch (error) {
      if (deps.isLive()) deps.setStatus(failureMessage(error, key, tonePerfectKey), true);
    } finally {
      busy = false;
      setFieldsDisabled(deps.fields, deps.save, false);
    }
  };
}

export function mountLanguageCoachSettings(container: HTMLElement, ctx: SettingsContext, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-language-coach-settings";
  const { form, fields, save, status } = buildForm(document);
  const recorderUi = buildRecorder(document);
  root.append(form, recorderUi.section);
  container.append(root);

  let disposed = false;
  // Once the learner edits, saves or is notified, a late initial load must not overwrite what they see.
  let newerThanLoad = false;
  const markNewer = () => { newerThanLoad = true; };
  watchEdits([fields.key.input, fields.tonePerfectKey.input, fields.region.input, fields.target.input, fields.first.input], markNewer);
  const isLive = () => !disposed && !signal.aborted;
  const setStatus = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("lh-language-coach-settings__status-error", error);
  };
  const onSubmit = createSubmitHandler({ ctx, fields, save, isLive, markNewer, setStatus });

  const clearResult = () => { recorderUi.details.textContent = ""; };

  /** Show the mapped scores and the per-sound or per-syllable detail. */
  const showResult = (result: Record<string, unknown>) => {
    setStatus(assessmentSummary(result));
    clearResult();
    for (const line of assessmentLines(result)) {
      const item = document.createElement("li");
      item.textContent = line;
      recorderUi.details.append(item);
    }
  };

  const flow = createRecordingFlow({
    call: (operation, input) => ctx.call(operation, input),
    isLive,
    setStatus,
    buttons: { record: recorderUi.record, stop: recorderUi.stop },
    readInputs: () => ({ referenceText: recorderUi.reference.value.trim(), locale: fields.target.input.value }),
    showResult,
    clearResult,
  });

  form.addEventListener("submit", onSubmit);
  recorderUi.record.addEventListener("click", () => { void flow.start(); });
  recorderUi.stop.addEventListener("click", () => { void flow.stop(); });
  const unsubscribe = ctx.onNotification(event => {
    if (event.topic !== "settings-changed" || disposed) return;
    try {
      const payload = record(event.data) ? event.data : {};
      const settings = readPublicSettings(payload);
      const profile = readCoachProfile(payload);
      markNewer();
      applyPublicSettings(fields, settings, profile);
    } catch {}
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    unsubscribe();
    form.removeEventListener("submit", onSubmit);
    fields.key.input.value = "";
    flow.dispose();
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });

  const initialise = async () => {
    try {
      const [settings, profile] = await loadSettings(ctx);
      if (isLive() && !newerThanLoad) applyPublicSettings(fields, settings, profile);
    } catch {
      if (isLive() && !newerThanLoad) setStatus("The saved settings could not be read.", true);
    }
  };
  void initialise();

  return dispose;
}

async function loadSettings(ctx: SettingsContext): Promise<[PublicSettings, CoachProfile]> {
  return Promise.all([
    readPublicSettings(await ctx.call("get-settings")),
    readCoachProfile(await ctx.call("get-coach-profile")),
  ]);
}
