import assert from "node:assert/strict";
import { test } from "node:test";
import { recordFromUserMedia, startRecorder } from "../src/recorder.ts";
import { encodeWav16kMono } from "../src/wav-encoder.ts";

test("encodeWav16kMono writes 16 kHz mono PCM with a WAV header", () => {
  const samples = new Float32Array([0, 0.5, -0.25, 0.125]);
  const wav = encodeWav16kMono(samples, 16_000);
  assert.equal(wav[0], "R".charCodeAt(0));
  assert.equal(wav[8], "W".charCodeAt(0));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.length, 44 + samples.length * 2);
});

test("encodeWav16kMono resamples non-16 kHz input", () => {
  const samples = new Float32Array(32_000);
  for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index / 100);
  const wav = encodeWav16kMono(samples, 32_000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(40, true), 16_000 * 2);
});

type FakeNode = {
  name: string;
  gain: { value: number };
  connectedTo: string[];
  connect: (target: { name?: string }) => void;
  disconnect: () => void;
  onaudioprocess: unknown;
};

const contexts: FakeAudioContext[] = [];

/** Stand in for the Web Audio graph the recorder builds. */
class FakeAudioContext {
  sampleRate = 16_000;
  destination = { name: "destination" };
  nodes: FakeNode[] = [];

  constructor() {
    contexts.push(this);
  }

  createMediaStreamSource(): FakeNode {
    return this.node("source");
  }

  createScriptProcessor(): FakeNode {
    return this.node("processor");
  }

  createGain(): FakeNode {
    return this.node("gain");
  }

  node(name: string): FakeNode {
    const created: FakeNode = {
      name,
      gain: { value: 1 },
      connectedTo: [],
      connect(target) { created.connectedTo.push(target?.name ?? "unknown"); },
      disconnect() {},
      onaudioprocess: null,
    };
    this.nodes.push(created);
    return created;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function installAudioContext(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  contexts.length = 0;
  Object.defineProperty(globalThis, "AudioContext", { value: FakeAudioContext, configurable: true, writable: true });
  return () => {
    Object.defineProperty(globalThis, "AudioContext", previous ?? { value: undefined, configurable: true, writable: true });
  };
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop() {} }] } as unknown as MediaStream;
}

test("the recorder routes the microphone through a muted node instead of the speakers", async () => {
  const restore = installAudioContext();
  try {
    const recorder = await startRecorder({ stream: fakeStream() });
    const context = contexts[0]!;
    const processor = context.nodes.find(node => node.name === "processor")!;
    const gain = context.nodes.find(node => node.name === "gain")!;
    assert.deepEqual(processor.connectedTo, ["gain"]);
    assert.deepEqual(gain.connectedTo, ["destination"]);
    assert.equal(gain.gain.value, 0);
    await recorder.stop();
  } finally {
    restore();
  }
});

test("recordFromUserMedia opens the microphone, stops it and returns 16 kHz mono WAV bytes", async () => {
  const restore = installAudioContext();
  try {
    let stops = 0;
    const stream = { getTracks: () => [{ stop() { stops += 1; } }] } as unknown as MediaStream;
    let requested: unknown;
    const wav = await recordFromUserMedia(async constraints => {
      requested = constraints;
      return stream;
    });

    assert.deepEqual(requested, { audio: { channelCount: 1, sampleRate: 16_000 }, video: false });
    assert.equal(stops, 1);
    assert.equal(wav[0], "R".charCodeAt(0));
    assert.equal(wav[8], "W".charCodeAt(0));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16_000);
    assert.equal(view.getUint16(34, true), 16);
  } finally {
    restore();
  }
});