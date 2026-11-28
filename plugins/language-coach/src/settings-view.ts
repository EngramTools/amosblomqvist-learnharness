import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { CoachLocale } from "./judge-types.ts";
import { RECORDING_LIMIT_MS, startRecorder, type RecorderHandle } from "./recorder.ts";

type SettingsContext = Pick<PluginFrontendContext, "call" | "onNotification">;

export type PublicSettings = {
  configured: boolean;
  region: string;
};

export type CoachProfile = {
  targetLanguage: CoachLocale;
  firstLanguage: string;
};

export const SPEECH_KEY_LABEL = "Azure Speech key";
export const SPEECH_KEY_DESCRIPTION = "Recorded clips are sent to Azure for pronunciation assessment. The key is stored in this plugin's data directory and is never shown in full.";
export const REGION_LABEL = "Azure Speech region";
export const TARGET_LANGUAGE_LABEL = "Target language";
export const FIRST_LANGUAGE_LABEL = "Learner first language";

export function readPublicSettings(value: unknown): PublicSettings {
  if (!record(value) || typeof value.configured !== "boolean" || typeof value.region !== "string") {
    throw new Error("Language coach settings are unavailable.");
  }
  return { configured: value.configured, region: value.region };
}

export function readCoachProfile(value: unknown): CoachProfile {
  if (!record(value) || (value.targetLanguage !== "en-US" && value.targetLanguage !== "zh-CN") || typeof value.firstLanguage !== "string") {
    throw new Error("Language coach profile is unavailable.");
  }
  return { targetLanguage: value.targetLanguage, firstLanguage: value.firstLanguage };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Never echo the key, including from validation and transport failures. */
function failureMessage(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : "The settings could not be saved.";
  return key && message.includes(key) ? "The settings could not be saved." : message;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Release the microphone when the capture never started or must not continue. */
function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export function mountLanguageCoachSettings(container: HTMLElement, ctx: SettingsContext, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-language-coach-settings";
  const form = document.createElement("form");
  form.className = "lh-language-coach-settings__form";

  const keyField = labeledPassword(document, SPEECH_KEY_LABEL, "lh-language-coach-key");
  const keyNote = note(document, SPEECH_KEY_DESCRIPTION);
  const regionField = labeledText(document, REGION_LABEL, "lh-language-coach-region", "westus");
  const targetField = labeledSelect(document, TARGET_LANGUAGE_LABEL, "lh-language-coach-target", [
    { value: "en-US", label: "English (en-US)" },
    { value: "zh-CN", label: "Mandarin (zh-CN)" },
  ]);
  const firstField = labeledText(document, FIRST_LANGUAGE_LABEL, "lh-language-coach-first", "en");

  const actions = document.createElement("div");
  actions.className = "lh-language-coach-settings__actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save settings";
  actions.append(save);

  const status = document.createElement("p");
  status.className = "lh-language-coach-settings__status";
  status.setAttribute("role", "status");

  const recorderSection = document.createElement("section");
  recorderSection.className = "lh-language-coach-settings__recorder";
  const recorderTitle = document.createElement("h3");
  recorderTitle.textContent = "Record a clip";
  const referenceInput = document.createElement("input");
  referenceInput.type = "text";
  referenceInput.placeholder = "Reference text to read aloud";
  referenceInput.className = "lh-language-coach-settings__input";
  const recordButton = document.createElement("button");
  recordButton.type = "button";
  recordButton.textContent = "Record";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.textContent = "Stop";
  stopButton.disabled = true;
  const recorderNote = note(document, `Recording stops automatically after ${RECORDING_LIMIT_MS / 1000} seconds.`);
  const details = document.createElement("ul");
  details.className = "lh-language-coach-settings__details";
  recorderSection.append(recorderTitle, referenceInput, recordButton, stopButton, recorderNote, details);

  form.append(keyField.field, keyNote, regionField.field, targetField.field, firstField.field, actions, status);
  root.append(form, recorderSection);
  container.append(root);

  let disposed = false;
  let busy = false;
  let stopping = false;
  let starting = false;
  let recorder: RecorderHandle | undefined;

  const isLive = () => !disposed && !signal.aborted;
  const apply = (settings: PublicSettings, profile: CoachProfile) => {
    keyField.input.placeholder = settings.configured ? "Saved key — enter a new key to replace it" : "Paste an Azure Speech key";
    regionField.input.value = settings.region;
    targetField.input.value = profile.targetLanguage;
    firstField.input.value = profile.firstLanguage;
  };

  const setStatus = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("lh-language-coach-settings__status-error", error);
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (busy || !isLive()) return;
    busy = true;
    const submittedKey = keyField.input.value.trim();
    keyField.input.disabled = true;
    save.disabled = true;
    try {
      const payload: Record<string, unknown> = {
        region: regionField.input.value,
        targetLanguage: targetField.input.value,
        firstLanguage: firstField.input.value,
      };
      if (submittedKey) payload.key = submittedKey;
      const saved = await ctx.call("save-settings", payload);
      const settings = readPublicSettings(saved);
      const profile = readCoachProfile(saved);
      if (!isLive()) return;
      if (submittedKey) keyField.input.value = "";
      apply(settings, profile);
      setStatus(submittedKey ? "Saved. Clips are sent to Azure for pronunciation assessment." : "Saved.");
    } catch (error) {
      if (!isLive()) return;
      setStatus(failureMessage(error, submittedKey), true);
    } finally {
      busy = false;
      keyField.input.disabled = false;
      save.disabled = false;
    }
  };

  const startRecording = async () => {
    if (!isLive() || recorder || starting || stopping) return;
    starting = true;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (!isLive()) {
        stopTracks(stream);
        return;
      }
      const handle = await startRecorder({ stream, onLimit: () => { void stopRecording(); } });
      recorder = handle;
      if (!isLive()) {
        recorder = undefined;
        await handle.stop().catch(() => {});
        return;
      }
      recordButton.disabled = true;
      stopButton.disabled = false;
      setStatus("Recording…");
    } catch (error) {
      if (stream) stopTracks(stream);
      if (!isLive()) return;
      setStatus(error instanceof Error ? error.message : "The microphone could not be opened.", true);
    } finally {
      starting = false;
    }
  };

  const stopRecording = async () => {
    if (!recorder || !isLive() || stopping) return;
    stopping = true;
    stopButton.disabled = true;
    const active = recorder;
    try {
      const wav = await active.stop();
      recorder = undefined;
      const referenceText = referenceInput.value.trim();
      if (!referenceText) {
        setStatus("Enter reference text before assessing a recording.", true);
        return;
      }
      const result = await ctx.call("assess-pronunciation", {
        wavBase64: bytesToBase64(wav),
        referenceText,
        locale: targetField.input.value,
      });
      if (!isLive()) return;
      if (!record(result)) {
        setStatus("The assessment result could not be read.", true);
        return;
      }
      if (result.status === "unavailable") {
        setStatus(typeof result.reason === "string" ? result.reason : "The pronunciation assessment is unavailable.", true);
        return;
      }
      renderAssessment(result);
    } catch (error) {
      recorder = undefined;
      if (!isLive()) return;
      setStatus(error instanceof Error ? error.message : "The recording could not be assessed.", true);
    } finally {
      stopping = false;
      recordButton.disabled = false;
      stopButton.disabled = true;
    }
  };

  /** Show the mapped scores and the per-sound or per-syllable detail. */
  const renderAssessment = (result: Record<string, unknown>) => {
    const scores = record(result.scores) ? result.scores : {};
    const summary: string[] = [];
    for (const label of ["accuracy", "fluency", "completeness", "prosody"]) {
      const score = readNumber(scores[label]);
      if (score === undefined) continue;
      summary.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} ${score}`);
    }
    setStatus(summary.length ? `Assessment received. ${summary.join(", ")}.` : "Assessment received.");
    details.textContent = "";
    for (const line of assessmentLines(result)) {
      const item = document.createElement("li");
      item.textContent = line;
      details.append(item);
    }
  };

  form.addEventListener("submit", onSubmit);
  recordButton.addEventListener("click", () => { void startRecording(); });
  stopButton.addEventListener("click", () => { void stopRecording(); });
  const unsubscribe = ctx.onNotification(event => {
    if (event.topic !== "settings-changed" || disposed) return;
    try {
      const payload = record(event.data) ? event.data : {};
      apply(readPublicSettings(payload), readCoachProfile(payload));
    } catch {}
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    unsubscribe();
    form.removeEventListener("submit", onSubmit);
    keyField.input.value = "";
    void recorder?.stop().catch(() => {});
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });

  void (async () => {
    try {
      const [settings, profile] = await Promise.all([
        readPublicSettings(await ctx.call("get-settings")),
        readCoachProfile(await ctx.call("get-coach-profile")),
      ]);
      if (isLive()) apply(settings, profile);
    } catch {
      if (isLive()) setStatus("The saved settings could not be read.", true);
    }
  })();

  return dispose;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One readable line per scored word, phoneme or syllable. */
function assessmentLines(result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const push = (values: unknown, label: (entry: Record<string, unknown>) => string, extra?: (entry: Record<string, unknown>) => string) => {
    if (!Array.isArray(values)) return;
    for (const entry of values) {
      if (!record(entry)) continue;
      lines.push(`${label(entry)} — ${readNumber(entry.score) ?? 0}${extra ? extra(entry) : ""}`);
    }
  };
  push(result.words, entry => readText(entry.word));
  push(result.phonemes, entry => readText(entry.phoneme), entry => {
    const heard = Array.isArray(entry.heard) ? entry.heard.filter(item => typeof item === "string") : [];
    return heard.length ? ` (heard: ${heard.join(", ")})` : "";
  });
  push(result.syllables, entry => readText(entry.pinyin) || readText(entry.syllable));
  return lines;
}

function note(document: Document, text: string): HTMLParagraphElement {
  const note = document.createElement("p");
  note.className = "lh-language-coach-settings__note";
  note.textContent = text;
  return note;
}

function labeledPassword(document: Document, label: string, id: string) {
  const field = document.createElement("label");
  field.className = "lh-language-coach-settings__field";
  const title = document.createElement("span");
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "password";
  input.id = id;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.className = "lh-language-coach-settings__input";
  field.append(title, input);
  return { field, input };
}

function labeledText(document: Document, label: string, id: string, placeholder: string) {
  const field = document.createElement("label");
  field.className = "lh-language-coach-settings__field";
  const title = document.createElement("span");
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.placeholder = placeholder;
  input.className = "lh-language-coach-settings__input";
  field.append(title, input);
  return { field, input };
}

function labeledSelect(document: Document, label: string, id: string, options: { value: string; label: string }[]) {
  const field = document.createElement("label");
  field.className = "lh-language-coach-settings__field";
  const title = document.createElement("span");
  title.textContent = label;
  const input = document.createElement("select");
  input.id = id;
  input.className = "lh-language-coach-settings__input";
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    input.append(element);
  }
  field.append(title, input);
  return { field, input };
}