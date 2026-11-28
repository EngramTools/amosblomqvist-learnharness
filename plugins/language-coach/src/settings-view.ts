import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { CoachLocale } from "./judge-types.ts";
import { assessmentLines, assessmentSummary } from "./assessment-details.ts";
import { RECORDING_LIMIT_MS } from "./recorder.ts";
import { createRecordingFlow } from "./recording-flow.ts";
import { createReferenceAudioPlayer } from "./reference-audio-player.ts";
import { button, note, passwordField, selectField, textField } from "./settings-fields.ts";
import { DEFAULT_EN_VOICE, DEFAULT_ZH_VOICE } from "./voice-config.ts";

type SettingsContext = Pick<PluginFrontendContext, "call" | "onNotification">;

type LabeledInput<T extends HTMLInputElement | HTMLSelectElement> = {
  field: HTMLLabelElement;
  input: T;
};

type FormFields = {
  key: LabeledInput<HTMLInputElement>;
  tonePerfectKey: LabeledInput<HTMLInputElement>;
  region: LabeledInput<HTMLInputElement>;
  enVoice: LabeledInput<HTMLInputElement>;
  zhVoice: LabeledInput<HTMLInputElement>;
  target: LabeledInput<HTMLSelectElement>;
  first: LabeledInput<HTMLInputElement>;
};

type FormUi = {
  form: HTMLFormElement;
  fields: FormFields;
  save: HTMLButtonElement;
  status: HTMLParagraphElement;
};

type RecorderUi = {
  section: HTMLElement;
  reference: HTMLInputElement;
  record: HTMLButtonElement;
  stop: HTMLButtonElement;
  play: HTMLButtonElement;
  audio: HTMLAudioElement;
  audioStatus: HTMLParagraphElement;
  details: HTMLUListElement;
};

export type PublicSettings = {
  configured: boolean;
  region: string;
  tonePerfectConfigured: boolean;
  enVoice: string;
  zhVoice: string;
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
export const EN_VOICE_LABEL = "English reference voice";
export const ZH_VOICE_LABEL = "Mandarin reference voice";
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
  return {
    configured: entry.configured,
    region: entry.region,
    tonePerfectConfigured: entry.tonePerfectConfigured,
    enVoice: typeof entry.enVoice === "string" && entry.enVoice.trim() ? entry.enVoice : DEFAULT_EN_VOICE,
    zhVoice: typeof entry.zhVoice === "string" && entry.zhVoice.trim() ? entry.zhVoice : DEFAULT_ZH_VOICE,
  };
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
    enVoice: textField(document, EN_VOICE_LABEL, "lh-language-coach-en-voice", DEFAULT_EN_VOICE),
    zhVoice: textField(document, ZH_VOICE_LABEL, "lh-language-coach-zh-voice", DEFAULT_ZH_VOICE),
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
    fields.enVoice.field,
    fields.zhVoice.field,
    fields.target.field,
    fields.first.field,
    actions,
    status,
  );
  return { form, fields, save, status };
}

function buildRecorder(document: Document): RecorderUi {
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
  const play = button(document, "button", "Play reference");
  play.disabled = true;
  const audio = document.createElement("audio");
  audio.preload = "none";
  audio.hidden = true;
  const audioStatus = document.createElement("p");
  audioStatus.className = "lh-language-coach-settings__status";
  audioStatus.setAttribute("role", "status");
  const details = document.createElement("ul");
  details.className = "lh-language-coach-settings__details";
  const limitNote = note(document, `Recording stops automatically after ${RECORDING_LIMIT_MS / 1000} seconds.`);
  section.append(title, reference, play, record, stop, audio, limitNote, audioStatus, details);
  return { section, reference, record, stop, play, audio, audioStatus, details };
}

function applyPublicSettings(fields: FormFields, settings: PublicSettings, profile: CoachProfile): void {
  fields.key.input.placeholder = settings.configured ? "Saved key — enter a new key to replace it" : "Paste an Azure Speech key";
  fields.tonePerfectKey.input.placeholder = settings.tonePerfectConfigured
    ? "Saved key — enter a new key to replace it"
    : "Paste a TonePerfect key";
  fields.region.input.value = settings.region;
  fields.enVoice.input.value = settings.enVoice;
  fields.zhVoice.input.value = settings.zhVoice;
  const target = Array.from(fields.target.input.options).find(option => option.value === profile.targetLanguage);
  if (target) target.selected = true;
  fields.first.input.value = profile.firstLanguage;
}

function settingsPayload(fields: FormFields, key: string, tonePerfectKey: string): Record<string, string> {
  return {
    region: fields.region.input.value,
    enVoice: fields.enVoice.input.value,
    zhVoice: fields.zhVoice.input.value,
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

function createResultView(
  document: Document,
  details: HTMLUListElement,
  setStatus: (message: string, error?: boolean) => void,
): { show: (result: Record<string, unknown>) => void; clear: () => void } {
  const clear = () => { details.textContent = ""; };
  const show = (result: Record<string, unknown>) => {
    setStatus(assessmentSummary(result));
    clear();
    for (const line of assessmentLines(result)) {
      const item = document.createElement("li");
      item.textContent = line;
      details.append(item);
    }
  };
  return { show, clear };
}

function subscribeSettings(
  ctx: SettingsContext,
  onPayload: (settings: PublicSettings, profile: CoachProfile) => void,
): () => void {
  return ctx.onNotification(event => {
    if (event.topic !== "settings-changed") return;
    try {
      const payload = record(event.data) ? event.data : {};
      onPayload(readPublicSettings(payload), readCoachProfile(payload));
    } catch {}
  });
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
  const isLive = () => !disposed && !signal.aborted;
  const setStatus = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("lh-language-coach-settings__status-error", error);
  };
  const player = createReferenceAudioPlayer({
    call: (operation, input) => ctx.call(operation, input),
    isLive,
    readInput: () => {
      const locale = fields.target.input.value;
      return { text: recorderUi.reference.value.trim(), locale: isLocale(locale) ? locale : "en-US" };
    },
    button: recorderUi.play,
    status: recorderUi.audioStatus,
    audio: recorderUi.audio,
  });
  const applySettings = (settings: PublicSettings, profile: CoachProfile) => {
    applyPublicSettings(fields, settings, profile);
    player.setAvailable(settings);
  };
  watchEdits(
    [
      fields.key.input,
      fields.tonePerfectKey.input,
      fields.region.input,
      fields.enVoice.input,
      fields.zhVoice.input,
      fields.target.input,
      fields.first.input,
      recorderUi.reference,
    ],
    () => {
      markNewer();
      player.reset();
    },
  );
  const onSubmit = createSubmitHandler({ ctx, fields, save, isLive, markNewer, setStatus });
  const results = createResultView(document, recorderUi.details, setStatus);

  const flow = createRecordingFlow({
    call: (operation, input) => ctx.call(operation, input),
    isLive,
    setStatus,
    buttons: { record: recorderUi.record, stop: recorderUi.stop },
    readInputs: () => ({ referenceText: recorderUi.reference.value.trim(), locale: fields.target.input.value }),
    showResult: results.show,
    clearResult: results.clear,
  });

  form.addEventListener("submit", onSubmit);
  recorderUi.record.addEventListener("click", () => { void flow.start(); });
  recorderUi.stop.addEventListener("click", () => { void flow.stop(); });
  recorderUi.play.addEventListener("click", () => { void player.play(); });
  const unsubscribe = subscribeSettings(ctx, (settings, profile) => {
    if (disposed) return;
    markNewer();
    applySettings(settings, profile);
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    unsubscribe();
    form.removeEventListener("submit", onSubmit);
    fields.key.input.value = "";
    flow.dispose();
    player.dispose();
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });

  const initialise = async () => {
    try {
      const [settings, profile] = await loadSettings(ctx);
      if (isLive() && !newerThanLoad) {
        applySettings(settings, profile);
      }
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
