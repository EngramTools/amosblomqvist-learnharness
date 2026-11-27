import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { isReady, type DeliveryWord, type ExplainBackPayload } from "./contract.ts";

/** Provenance of an unedited dictation, published with the answer. An edit
 *  after the last dictation delivery drops it: the text is no longer the
 *  verbatim speech the timings describe. */
export type DictationProvenance = { language: string; words: DeliveryWord[] };

export type EditorOptions = {
  /** Interview mode: opt in to `{text, words}` dictation and keep timings. */
  interviewMode: boolean;
};

function answerText(answer: PluginQuestionAnswerState): string {
  if (answer.status === "empty") return "";
  const value = answer.value;
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") {
    throw new Error("Explain-back answers must contain explanation text.");
  }
  return value.text;
}

function published(text: string, provenance: DictationProvenance | undefined): PluginQuestionAnswerState {
  if (text === "") return { status: "empty" };
  const value: Record<string, unknown> = { text };
  if (provenance) {
    value.language = provenance.language;
    value.words = provenance.words;
  }
  return { status: isReady(text) ? "ready" : "unready", value: value as { text: string } };
}

/** Append dictation without eating its leading/trailing whitespace. */
export function appendTranscriptText(before: string, transcript: string): string {
  if (before === "" || /\s$/.test(before) || /^\s/.test(transcript)) return before + transcript;
  return `${before} ${transcript}`;
}

function toWords(speech: { words?: readonly { word: string; start: number; end: number; confidence: number }[] }): DeliveryWord[] {
  return (speech.words ?? []).map(({ word, start, end, confidence }) => ({ word, start, end, confidence }));
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<ExplainBackPayload>, options: EditorOptions = { interviewMode: false }): PluginQuestionEditorHandle {
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
  /** Verbatim-speech provenance of the current text; cleared by any edit. */
  let provenance: DictationProvenance | undefined;
  const publish = () => {
    if (disposed || props.signal.aborted) return;
    props.onChange(published(textarea.value, provenance));
  };
  const syncActive = (next: boolean) => {
    active = next;
    textarea.readOnly = !next;
  };
  const onInput = () => {
    if (!applying && active) {
      provenance = undefined; // typed edits invalidate the dictation timings
      publish();
    }
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
  const appendProvenance = (before: string, incoming: DictationProvenance | undefined): DictationProvenance | undefined => {
    if (!before) return incoming;
    if (!provenance || !incoming) return undefined;
    return { language: incoming.language, words: [...provenance.words, ...incoming.words] };
  };
  textarea.addEventListener("input", onInput);
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  syncActive(active);
  setValue(answerText(props.answer));
  publish();

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
      const before = textarea.value;
      provenance = appendProvenance(before, undefined);
      setValue(appendTranscriptText(before, text));
      if (typeof textarea.setSelectionRange === "function") textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      publish();
    },
    ...(options.interviewMode ? {
      wantsDictatedWords: true,
      appendDictatedSpeech(speech) {
        if (disposed || props.signal.aborted) return;
        const before = textarea.value;
        const language = typeof speech.language === "string" ? speech.language : undefined;
        provenance = language ? appendProvenance(before, { language, words: toWords(speech) }) : appendProvenance(before, undefined);
        setValue(appendTranscriptText(before, speech.text));
        if (typeof textarea.setSelectionRange === "function") textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        publish();
      },
    } : {}),
    dispose,
  };
}
