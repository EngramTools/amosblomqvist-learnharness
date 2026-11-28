import { encodeWav16kMono } from "./wav-encoder.ts";

export const RECORDING_LIMIT_MS = 30_000;
const TARGET_SAMPLE_RATE = 16_000;

export type RecorderHandle = {
  stop: () => Promise<Uint8Array>;
};

export type RecorderOptions = {
  stream: MediaStream;
  limitMs?: number;
  /** Called when the time limit ends the capture, so the view can finish the clip. */
  onLimit?: () => void;
};

/** Capture microphone audio until stop or the 30 s limit. */
export async function startRecorder(options: RecorderOptions): Promise<RecorderHandle> {
  const limitMs = options.limitMs ?? RECORDING_LIMIT_MS;
  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = context.createMediaStreamSource(options.stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  // A ScriptProcessor only runs while it reaches the destination; mute it so the microphone is never monitored.
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunks: Float32Array[] = [];
  let finished: Promise<Uint8Array> | undefined;

  const finish = async (): Promise<Uint8Array> => {
    if (finished) return finished;
    finished = (async () => {
      processor.disconnect();
      mute.disconnect();
      source.disconnect();
      for (const track of options.stream.getTracks()) track.stop();
      const sampleRate = context.sampleRate;
      await context.close();
      const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
      const merged = new Float32Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return encodeWav16kMono(merged, sampleRate);
    })();
    return finished;
  };

  processor.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(Float32Array.from(input));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  const limitTimer = setTimeout(() => {
    void finish();
    options.onLimit?.();
  }, limitMs);

  return {
    stop: async () => {
      clearTimeout(limitTimer);
      return finish();
    },
  };
}

export async function recordFromUserMedia(getUserMedia: typeof navigator.mediaDevices.getUserMedia, limitMs = RECORDING_LIMIT_MS): Promise<Uint8Array> {
  const stream = await getUserMedia({ audio: { channelCount: 1, sampleRate: TARGET_SAMPLE_RATE }, video: false });
  const recorder = await startRecorder({ stream, limitMs });
  return recorder.stop();
}