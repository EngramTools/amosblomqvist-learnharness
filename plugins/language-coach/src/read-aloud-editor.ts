import type { PluginQuestionEditorHandle, PluginQuestionEditorProps } from "learnharness-plugin-api";
import { recordFromUserMedia, stopTracks } from "./recorder.ts";

type BytesToBase64 = (bytes: Uint8Array) => string;

const READY = "The recording is ready. Submit to see your pronunciation results.";
const RECORDING = "Recording…";
const NEEDS_RECORDING = "Record yourself reading the text before submitting.";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** The read-aloud answer editor: one Record button, a status line, controlled publishing. */
export function mountReadAloudEditor(container: HTMLElement, props: PluginQuestionEditorProps): PluginQuestionEditorHandle {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-coach-read-aloud-editor";
  container.append(root);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lh-coach-read-aloud-editor__record";
  button.textContent = "Record";
  const status = document.createElement("div");
  status.className = "lh-coach-read-aloud-editor__status";
  status.setAttribute("role", "status");
  status.textContent = NEEDS_RECORDING;
  root.append(button, status);

  let recording: string | undefined;
  let live = true;
  let capturing: Promise<Uint8Array> | undefined;
  let stream: MediaStream | undefined;

  const publish = (state: "empty" | "ready") => {
    props.onChange(state === "ready" && recording !== undefined
      ? { status: "ready", value: { recording } }
      : { status: "empty" });
  };

  const stopTracksIfOpen = () => {
    if (stream) stopTracks(stream);
    stream = undefined;
  };

  const capture = async () => {
    button.disabled = true;
    status.textContent = RECORDING;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    capturing = recordFromUserMedia(() => Promise.resolve(stream!));
    const wav = await capturing;
    capturing = undefined;
    stopTracksIfOpen();
    if (!live) return;
    recording = bytesToBase64(wav);
    button.disabled = false;
    button.textContent = "Record again";
    status.textContent = READY;
    publish("ready");
  };

  const fail = (error: unknown) => {
    capturing = undefined;
    stopTracksIfOpen();
    if (!live) return;
    button.disabled = false;
    status.textContent = error instanceof Error ? error.message : "The microphone could not be opened.";
  };

  button.addEventListener("click", () => {
    if (capturing) return;
    capture().catch(fail);
  });

  publish(recording === undefined ? "empty" : "ready");

  return {
    update(next: { answer: { status: string }; active: boolean }) {
      live = next.active || live;
      if (!next.active) return;
    },
    focus() {
      button.focus();
    },
    dispose() {
      live = false;
      stopTracksIfOpen();
      root.remove();
    },
  };
}
