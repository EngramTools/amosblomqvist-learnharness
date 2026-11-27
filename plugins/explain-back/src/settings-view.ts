import type { PluginFrontendContext } from "learnharness-plugin-api";

type SettingsContext = Pick<PluginFrontendContext, "call" | "onNotification">;

export type PublicSettings = { hasTypesafeKey: boolean };

export const TYPESAFE_KEY_LABEL = "TypeSafe API key";
export const TYPESAFE_KEY_DESCRIPTION = "Learner text is sent to TypeSafe for criterion scoring. The key is stored in this plugin's data directory and is never shown in full.";

export function readPublicSettings(value: unknown): PublicSettings {
  if (!record(value) || typeof value.hasTypesafeKey !== "boolean") throw new Error("Explain-back settings are unavailable.");
  return { hasTypesafeKey: value.hasTypesafeKey };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type SettingsForm = {
  form: HTMLFormElement;
  input: HTMLInputElement;
  save: HTMLButtonElement;
  apply: (settings: PublicSettings) => void;
  setStatus: (message: string, error?: boolean) => void;
  setBusy: (busy: boolean) => void;
};

let mountCount = 0;

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
  form.append(field, note, actions, status);

  return {
    form,
    input,
    save,
    apply(settings) {
      input.placeholder = settings.hasTypesafeKey ? "Saved key — enter a new key to replace it" : "Paste a TypeSafe API key";
      save.textContent = settings.hasTypesafeKey ? "Replace key" : "Save key";
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
    request.form.input.value = "";
    request.form.apply(settings);
    request.form.setStatus("Saved. Learner text is sent to TypeSafe for scoring.");
  } catch (error) {
    if (request.signal.aborted) return;
    const message = error instanceof Error ? error.message : "The key could not be saved.";
    request.form.setStatus(message.includes(request.key) ? "The key could not be saved." : message, true);
  } finally {
    request.form.setBusy(false);
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
