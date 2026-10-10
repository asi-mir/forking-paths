import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static copies of voiced clips, committed under `public/audio/` (`<clipId>.mp3` plus
 * `manifest.json`). The desk demo's lines and the sounds are exported here once, so a fresh
 * deployment with an empty database, no ElevenLabs key or no credits left still speaks them.
 * `GET /api/audio/[clipId]` and the voice step look here after the database.
 */

/** Where static clips live. Null turns static lookups off. */
export type StaticDir = string | null;

export const STATIC_AUDIO_DIR = join(process.cwd(), "public", "audio");

/** A clip id: 32 lowercase hex characters (see `clipIdFor`). Anything else is never a file name. */
export function isClipId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

export type StaticClipKind = "line" | "sound";

export type StaticManifest = {
  /** The voice and TTS model the lines were voiced with; null when only sounds were exported. */
  voiceId: string | null;
  modelId: string | null;
  clips: Record<string, { kind: StaticClipKind; text: string }>;
};

const manifests = new Map<string, StaticManifest | null>();

export function readStaticManifest(dir: StaticDir = STATIC_AUDIO_DIR): StaticManifest | null {
  if (!dir) return null;
  if (!manifests.has(dir)) {
    let manifest: StaticManifest | null = null;
    try {
      const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Partial<StaticManifest>;
      if (raw.clips && typeof raw.clips === "object") {
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        manifest = { voiceId: str(raw.voiceId), modelId: str(raw.modelId), clips: raw.clips };
      }
    } catch {
      manifest = null;
    }
    manifests.set(dir, manifest);
  }
  return manifests.get(dir) ?? null;
}

export function hasStaticClip(id: string, dir: StaticDir = STATIC_AUDIO_DIR): boolean {
  return Boolean(dir) && isClipId(id) && existsSync(join(dir!, `${id}.mp3`));
}

export function readStaticClip(id: string, dir: StaticDir = STATIC_AUDIO_DIR): Uint8Array | null {
  if (!dir || !isClipId(id)) return null;
  try {
    return new Uint8Array(readFileSync(join(dir, `${id}.mp3`)));
  } catch {
    return null;
  }
}

export type StaticClipEntry = { id: string; kind: StaticClipKind; text: string; mp3: Uint8Array };

/**
 * Writes clips as `<id>.mp3` and merges them into the manifest (scripts only). `voice` is the
 * voice and model of the lines in `entries`; leave it out for sounds only. Lines of another
 * voice replace the manifest's voice, and its old line entries are dropped from the manifest
 * (their files stay until someone deletes them).
 */
export function writeStaticClips(
  entries: StaticClipEntry[],
  voice: { voiceId: string; modelId: string } | null,
  dir: string = STATIC_AUDIO_DIR,
): { written: number; bytes: number } {
  mkdirSync(dir, { recursive: true });
  manifests.delete(dir);
  const old = readStaticManifest(dir);
  manifests.delete(dir);
  const keep = voice ?? { voiceId: old?.voiceId ?? null, modelId: old?.modelId ?? null };
  const sameVoice = old && old.voiceId === keep.voiceId && old.modelId === keep.modelId;
  const clips: StaticManifest["clips"] = {};
  for (const [id, entry] of Object.entries(old?.clips ?? {})) {
    if (sameVoice || entry.kind === "sound") clips[id] = entry;
  }
  let bytes = 0;
  for (const e of entries) {
    if (!isClipId(e.id)) throw new Error(`not a clip id: ${e.id}`);
    writeFileSync(join(dir, `${e.id}.mp3`), e.mp3);
    clips[e.id] = { kind: e.kind, text: e.text };
    bytes += e.mp3.byteLength;
  }
  const sorted = Object.fromEntries(Object.entries(clips).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: StaticManifest = { voiceId: keep.voiceId, modelId: keep.modelId, clips: sorted };
  const tmp = join(dir, "manifest.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, join(dir, "manifest.json"));
  manifests.delete(dir);
  return { written: entries.length, bytes };
}
