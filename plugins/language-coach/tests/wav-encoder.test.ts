import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWav16kMono } from "../src/wav-encoder.ts";

test("encodeWav16kMono writes 16 kHz mono PCM with a WAV header", () => {
  const samples = new Float32Array([0, 0.5, -0.25, 0.125]);
  const wav = encodeWav16kMono(samples, 16_000);
  assert.equal(wav[0], "R".charCodeAt(0));
  assert.equal(wav[8], "W".charCodeAt(0));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
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