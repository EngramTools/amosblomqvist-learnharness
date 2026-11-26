import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { isReady, type ExplainBackPayload } from "./contract.ts";

function answerText(answer: PluginQuestionAnswerState): string {
  if (answer.status === "empty") return "";
  const value = answer.value;
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") {
    throw new Error("Explain-back answers must contain explanation text.");
  }
  return value.text;
}

function published(text: string): PluginQuestionAnswerState {
  if (text === "") return { status: "empty" };
  return { status: isReady(text) ? "ready" : "unready", value: { text } };
}

/** Append dictation without eating its leading/trailing whitespace. */
export function appendTranscriptText(before: string, transcript: string): string {
  if (before === "" || /\s$/.test(before) || /^\s/.test(transcript)) return before + transcript;
  return `${before} ${transcript}`;
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<ExplainBackPayload>): PluginQuestionEditorHandle {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-explain-back-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "lh-explain-back-editor__input";
  textarea.placeholder = "Explain the step in your own words.";
  textarea.setAttribute("aria-label", "Your explanation");
  textarea.rows = 4;
  textarea.spellcheck = true;
  textarea.autocomplete = "off";
  root.append(textarea);
  container.append(root);

  let disposed = false;
  let active = props.active;
  let applying = false;
  const publish = (text: string) => {
    if (disposed || props.signal.aborted) return;
    props.onChange(published(text));
  };
  const syncActive = (next: boolean) => {
    active = next;
    textarea.readOnly = !next;
  };
  const onInput = () => {
    if (!applying && active) publish(textarea.value);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    textarea.removeEventListener("input", onInput);
    root.remove();
  };
  const setValue = (text: string) => {
    if (textarea.value === text) return;
    applying = true;
    try { textarea.value = text; } finally { applying = false; }
  };
  textarea.addEventListener("input", onInput);
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  syncActive(active);
  setValue(answerText(props.answer));
  publish(textarea.value);

  return {
    update(next) {
      if (disposed) return;
      syncActive(next.active);
      setValue(answerText(next.answer));
    },
    focus() {
      if (!disposed && active) textarea.focus();
    },
    appendTranscript(text) {
      if (disposed || props.signal.aborted) return;
      setValue(appendTranscriptText(textarea.value, text));
      if (typeof textarea.setSelectionRange === "function") textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      publish(textarea.value);
    },
    dispose,
  };
}
