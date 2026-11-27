import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { isReady, readProvenance, type DeliveryWord, type DictationProvenance, type ExplainBackPayload } from "./contract.ts";

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

/** The provenance a saved answer already carries (a remounted or restored
 *  editor must republish it, not strip it). Unreadable timings read as none. */
function answerProvenance(answer: PluginQuestionAnswerState): DictationProvenance | undefined {
  if (answer.status === "empty") return undefined;
  const value = answer.value as Record<string, unknown>;
  try {
    return readProvenance(value.language === undefined && value.words === undefined ? undefined : value);
  } catch {
    return undefined;
  }
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
  let provenance: DictationProvenance | undefined = answerProvenance(props.answer);
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
    // Each dictation run times its words from its own start, so a later run
    // is shifted past the words already kept to stay on one ordered timeline.
    // The silence between runs is not measured; only each run's own leading
    // silence shows up as a gap.
    const offset = provenance.words.at(-1)?.end ?? 0;
    const shifted = incoming.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset }));
    return { language: incoming.language, words: [...provenance.words, ...shifted] };
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
      const text = answerText(next.answer);
      // Our own echoed state keeps its provenance; a replaced answer brings its own.
      if (text !== textarea.value) provenance = answerProvenance(next.answer);
      setValue(text);
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
