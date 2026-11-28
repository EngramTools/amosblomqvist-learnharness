import { startRecorder, type RecorderHandle } from "./recorder.ts";

export type RecordingDeps = {
  call: (operation: string, input?: unknown) => Promise<unknown>;
  isLive: () => boolean;
  setStatus: (message: string, error?: boolean) => void;
  buttons: { record: HTMLButtonElement; stop: HTMLButtonElement };
  readInputs: () => { referenceText: string; locale: string };
  showResult: (result: Record<string, unknown>) => void;
};

type Phase = "idle" | "starting" | "recording" | "stopping";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Record one clip at a time and hand it to the backend judge. */
export function createRecordingFlow(deps: RecordingDeps) {
  const { call, isLive, setStatus, buttons } = deps;
  let phase: Phase = "idle";
  let recorder: RecorderHandle | undefined;

  const setButtons = (recording: boolean) => {
    buttons.record.disabled = recording;
    buttons.stop.disabled = !recording;
  };

  const report = (error: unknown, fallback: string) => {
    if (isLive()) setStatus(error instanceof Error ? error.message : fallback, true);
  };

  const present = (result: unknown) => {
    if (!isRecord(result)) setStatus("The assessment result could not be read.", true);
    else if (result.status === "unavailable") setStatus(typeof result.reason === "string" ? result.reason : "The pronunciation assessment is unavailable.", true);
    else deps.showResult(result);
  };

  const capture = async (stream: MediaStream) => {
    const handle = await startRecorder({ stream, onLimit: () => { void stop(); } });
    if (!isLive()) {
      await handle.stop().catch(() => {});
      return;
    }
    recorder = handle;
    phase = "recording";
    setButtons(true);
    setStatus("Recording…");
  };

  const start = async () => {
    if (!isLive() || phase !== "idle") return;
    phase = "starting";
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (isLive()) await capture(stream);
      else stopTracks(stream);
    } catch (error) {
      if (stream) stopTracks(stream);
      report(error, "The microphone could not be opened.");
    } finally {
      if (phase === "starting") phase = "idle";
    }
  };

  const assess = async (wav: Uint8Array) => {
    const { referenceText, locale } = deps.readInputs();
    if (!referenceText) {
      setStatus("Enter reference text before assessing a recording.", true);
      return;
    }
    const result = await call("assess-pronunciation", { wavBase64: bytesToBase64(wav), referenceText, locale });
    if (isLive()) present(result);
  };

  const canStop = () => isLive() && phase === "recording";

  const stop = async () => {
    const active = recorder;
    if (!active || !canStop()) return;
    phase = "stopping";
    buttons.stop.disabled = true;
    try {
      const wav = await active.stop();
      recorder = undefined;
      await assess(wav);
    } catch (error) {
      recorder = undefined;
      report(error, "The recording could not be assessed.");
    } finally {
      phase = "idle";
      setButtons(false);
    }
  };

  const dispose = () => {
    void recorder?.stop().catch(() => {});
  };

  return { start, stop, dispose };
}
