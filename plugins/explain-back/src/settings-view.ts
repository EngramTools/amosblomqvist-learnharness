import type { PluginFrontendContext } from "learnharness-plugin-api";

type SettingsContext = Pick<PluginFrontendContext, "call" | "onNotification">;

export type PublicSettings = { hasTypesafeKey: boolean; interviewMode: boolean; pauseThresholdSeconds: number };

export const TYPESAFE_KEY_LABEL = "TypeSafe API key";
export const TYPESAFE_KEY_DESCRIPTION = "Learner text is sent to TypeSafe for criterion scoring. The key is stored in this plugin's data directory and is never shown in full.";
export const INTERVIEW_MODE_LABEL = "Interview mode";
export const INTERVIEW_MODE_DESCRIPTION = "Dictated English answers also report fillers per minute, words per minute and long pauses. Delivery feedback stays off by default.";
export const PAUSE_THRESHOLD_LABEL = "Long-pause threshold (seconds)";
export const PAUSE_THRESHOLD_DESCRIPTION = "Pauses at or above this many seconds are reported in delivery metrics. Between 0.5 and 10.";

export function readPublicSettings(value: unknown): PublicSettings {
  if (!record(value) || typeof value.hasTypesafeKey !== "boolean" || typeof value.interviewMode !== "boolean" || typeof value.pauseThresholdSeconds !== "number") {
    throw new Error("Explain-back settings are unavailable.");
  }
  return { hasTypesafeKey: value.hasTypesafeKey, interviewMode: value.interviewMode, pauseThresholdSeconds: value.pauseThresholdSeconds };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type SettingsForm = {
  form: HTMLFormElement;
  input: HTMLInputElement;
  interviewToggle: HTMLInputElement;
  thresholdInput: HTMLInputElement;
  save: HTMLButtonElement;
  apply: (settings: PublicSettings) => void;
  setStatus: (message: string, error?: boolean) => void;
  setBusy: (busy: boolean) => void;
};

let mountCount = 0;

function createNumberRow(document: Document, label: string, description: string, id: string): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = document.createElement("label");
  field.className = "lh-explain-back-settings__field";
  const fieldLabel = document.createElement("span");
  fieldLabel.className = "lh-explain-back-settings__label";
  fieldLabel.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.5";
  input.min = "0.5";
  input.max = "10";
  input.className = "lh-explain-back-settings__input";
  input.id = id;
  fieldLabel.setAttribute("for", id);
  const note = document.createElement("p");
  note.className = "lh-explain-back-settings__note";
  note.textContent = description;
  field.append(fieldLabel, input, note);
  return { field, input };
}

function createToggleRow(document: Document, label: string, description: string, id: string): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = document.createElement("label");
  field.className = "lh-explain-back-settings__field";
  const fieldLabel = document.createElement("span");
  fieldLabel.className = "lh-explain-back-settings__label";
  fieldLabel.textContent = label;
  fieldLabel.setAttribute("for", id);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  const note = document.createElement("p");
  note.className = "lh-explain-back-settings__note";
  note.textContent = description;
  field.append(fieldLabel, input, note);
  return { field, input };
}

function createSettingsForm(document: Document): SettingsForm {
  const form = document.createElement("form");
  form.className = "lh-explain-back-settings__form";
  const field = document.createElement("label");
  field.className = "lh-explain-back-settings__field";
  const fieldLabel = document.createElement("span");
  fieldLabel.className = "lh-explain-back-settings__label";
  fieldLabel.textContent = TYPESAFE_KEY_LABEL;
  const input = document.createElement("input");
  input.type = "password";
  input.className = "lh-explain-back-settings__input";
  input.autocomplete = "off";
  input.spellcheck = false;
  const note = document.createElement("p");
  const noteId = `lh-explain-back-typesafe-note-${++mountCount}`;
  note.id = noteId;
  note.className = "lh-explain-back-settings__note";
  note.textContent = TYPESAFE_KEY_DESCRIPTION;
  input.setAttribute("aria-describedby", noteId);
  field.append(fieldLabel, input);

  const interview = createToggleRow(document, INTERVIEW_MODE_LABEL, INTERVIEW_MODE_DESCRIPTION, `lh-explain-back-interview-${mountCount}`);
  const threshold = createNumberRow(document, PAUSE_THRESHOLD_LABEL, PAUSE_THRESHOLD_DESCRIPTION, `lh-explain-back-threshold-${mountCount}`);

  const actions = document.createElement("div");
  actions.className = "lh-explain-back-settings__actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "lh-explain-back-settings__save";
  save.textContent = "Save key";
  actions.append(save);

  const status = document.createElement("p");
  status.className = "lh-explain-back-settings__status";
  status.setAttribute("role", "status");
  form.append(field, note, interview.field, threshold.field, actions, status);

  return {
    form,
    input,
    interviewToggle: interview.input,
    thresholdInput: threshold.input,
    save,
    apply(settings) {
      input.placeholder = settings.hasTypesafeKey ? "Saved key — enter a new key to replace it" : "Paste a TypeSafe API key";
      save.textContent = settings.hasTypesafeKey ? "Replace key" : "Save key";
      interview.input.checked = settings.interviewMode;
      threshold.input.value = String(settings.pauseThresholdSeconds);
    },
    setStatus(message, error = false) {
      status.textContent = message;
      status.classList.toggle("lh-explain-back-settings__status-error", error);
    },
    setBusy(busy) {
      input.disabled = busy;
      save.disabled = busy;
    },
  };
}

type SaveKeyRequest = {
  ctx: SettingsContext;
  signal: AbortSignal;
  key: string;
  form: SettingsForm;
};

async function saveTypesafeKey(request: SaveKeyRequest): Promise<void> {
  request.form.setBusy(true);
  try {
    const settings = readPublicSettings(await request.ctx.call("set-typesafe-key", { key: request.key }));
    if (request.signal.aborted) return;
    const saved = await saveDeliverySettings(request, settings);
    if (request.signal.aborted) return;
    request.form.input.value = "";
    request.form.apply(saved);
    request.form.setStatus("Saved. Learner text is sent to TypeSafe for scoring.");
  } catch (error) {
    if (request.signal.aborted) return;
    const message = error instanceof Error ? error.message : "The key could not be saved.";
    request.form.setStatus(message.includes(request.key) ? "The key could not be saved." : message, true);
  } finally {
    request.form.setBusy(false);
  }
}

/** Push the interview toggle and pause threshold; falls back to the last
 *  confirmed settings when their save fails, so the rows stay truthful. */
async function saveDeliverySettings(request: SaveKeyRequest, fallback: PublicSettings): Promise<PublicSettings> {
  try {
    const interview = readPublicSettings(await request.ctx.call("set-interview-mode", { mode: request.form.interviewToggle.checked }));
    if (request.signal.aborted) return fallback;
    const thresholdValue = Number(request.form.thresholdInput.value);
    if (!Number.isFinite(thresholdValue)) throw new Error("The pause threshold must be a number of seconds.");
    return readPublicSettings(await request.ctx.call("set-pause-threshold", { seconds: thresholdValue }));
  } catch (error) {
    if (request.signal.aborted) return fallback;
    // The key is saved; only the delivery rows failed. Surface their error.
    request.form.setStatus(error instanceof Error ? error.message : "The delivery settings could not be saved.", true);
    return fallback;
  }
}

async function readSettings(ctx: SettingsContext, form: SettingsForm, isLive: () => boolean): Promise<void> {
  try {
    const settings = readPublicSettings(await ctx.call("get-settings"));
    if (isLive()) form.apply(settings);
  } catch {
    if (isLive()) form.setStatus("The saved key status could not be read.", true);
  }
}

export function mountTypesafeSettings(container: HTMLElement, ctx: SettingsContext, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-explain-back-settings";
  const form = createSettingsForm(document);
  root.append(form.form);
  container.append(root);

  let disposed = false;
  let busy = false;
  const isLive = () => !disposed && !signal.aborted;
  const submit = async () => {
    if (busy || !isLive()) return;
    const key = form.input.value.trim();
    if (!key) {
      form.setStatus("Enter a TypeSafe API key.", true);
      form.input.focus();
      return;
    }
    busy = true;
    try { await saveTypesafeKey({ ctx, signal, key, form }); }
    finally { busy = false; }
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    void submit();
  };
  form.form.addEventListener("submit", onSubmit);
  const unsubscribe = ctx.onNotification(event => {
    if (event.topic !== "settings-changed" || disposed) return;
    try { form.apply(readPublicSettings(event.data)); } catch {}
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    unsubscribe();
    form.form.removeEventListener("submit", onSubmit);
    form.input.value = "";
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  void readSettings(ctx, form, isLive);
  return dispose;
}
