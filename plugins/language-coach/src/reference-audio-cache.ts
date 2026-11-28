import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_REFERENCE_CACHE_ENTRIES = 64;

const INDEX_FILE = "index.json";
const KEY_PATTERN = /^[a-f0-9]{64}$/;

export type ReferenceAudioIdentity = { voice: string; text: string; pronunciation: string };
export type CachedReferenceAudio = { audio: Uint8Array; contentType: string };

type CacheEntry = { key: string; contentType: string };
type StoreReferenceAudio = {
  directory: string;
  key: string;
  audio: Uint8Array;
  contentType: string;
  maxEntries?: number;
};

export function referenceAudioKey(identity: ReferenceAudioIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.voice, identity.text, identity.pronunciation]))
    .digest("hex");
}

function audioFile(directory: string, key: string): string {
  return path.join(directory, `${key}.mp3`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEntry(value: unknown): value is CacheEntry {
  return record(value)
    && typeof value.key === "string" && KEY_PATTERN.test(value.key)
    && typeof value.contentType === "string";
}

/** A damaged index is treated as an empty cache; cached audio is always regenerable. */
function readIndex(directory: string): CacheEntry[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, INDEX_FILE), "utf8"));
    return Array.isArray(value) ? value.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function writeTemporary(directory: string, prefix: string, data: string | Uint8Array): string {
  const temporary = path.join(directory, `.${prefix}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function writeIndex(directory: string, entries: CacheEntry[]): void {
  const temporary = writeTemporary(directory, "index", JSON.stringify(entries) + "\n");
  try {
    fs.renameSync(temporary, path.join(directory, INDEX_FILE));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeAudio(directory: string, key: string, audio: Uint8Array): void {
  const temporary = writeTemporary(directory, key, audio);
  try {
    fs.renameSync(temporary, audioFile(directory, key));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function cacheLimit(maxEntries: number | undefined): number {
  return maxEntries !== undefined && Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : DEFAULT_REFERENCE_CACHE_ENTRIES;
}

export function readCachedReferenceAudio(directory: string, key: string): CachedReferenceAudio | undefined {
  const entry = readIndex(directory).find(item => item.key === key);
  if (!entry) return undefined;
  try {
    const audio = new Uint8Array(fs.readFileSync(audioFile(directory, key)));
    return audio.length ? { audio, contentType: entry.contentType } : undefined;
  } catch {
    return undefined;
  }
}

/** Insertion order is age order, so the first entries are the oldest. */
export function writeCachedReferenceAudio(store: StoreReferenceAudio): void {
  fs.mkdirSync(store.directory, { recursive: true });
  const entries = readIndex(store.directory).filter(entry => entry.key !== store.key);
  writeAudio(store.directory, store.key, store.audio);
  entries.push({ key: store.key, contentType: store.contentType });
  const evicted = entries.splice(0, Math.max(0, entries.length - cacheLimit(store.maxEntries)));
  for (const entry of evicted) fs.rmSync(audioFile(store.directory, entry.key), { force: true });
  writeIndex(store.directory, entries);
}
