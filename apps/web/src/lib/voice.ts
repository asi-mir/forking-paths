import { createHash } from "node:crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { SpokenLine } from "@/quest/api";
import type { Lang, Quest } from "@/quest/schema";
import type { QuestLineKey } from "./audio-mix";
import { budgetTake } from "./budget";
import { getStore, type Store } from "./store";
import { withSpan } from "./trace";
import { hasStaticClip, readStaticClip, readStaticManifest, STATIC_AUDIO_DIR, type StaticDir } from "./voice-static";

/**
 * The narrator's voice (ElevenLabs): text to speech with v4 audio tags, a short ambience and
 * two stingers, all cached as clips.
 *
 * - A clip id is hash(text + voice + model), so the same line is paid for once. Clips live in
 *   the store (MongoDB `clips`, or memory) and, for the desk demo, in `public/audio/`.
 * - A quest is voiced when a run starts (`voiceQuest`), never when it is generated. Bridge
 *   lines are voiced on demand during the walk (`speak`). Both take characters from the daily
 *   `tts-chars` budget first; over the cap they make no request and the screen shows text.
 * - The app calls ElevenLabs only when `ELEVENLABS_LIVE=1` (set it on the host). Locally, in
 *   tests and in scripts that do not ask for it, clips already cached still play and nothing
 *   new is voiced, so a test or a browser check never spends credits.
 */

export const DEFAULT_TTS_MODEL = "eleven_v4";
export const SFX_MODEL = "eleven_text_to_sound_v2";
/** Mono speech at 64 kbps: ~8 KB per second, light enough to preload a run on mobile data. */
export const TTS_OUTPUT_FORMAT = "mp3_44100_64";
export const SFX_OUTPUT_FORMAT = "mp3_44100_128";
/** The `voiceId` stored with a sound clip. */
export const SFX_VOICE_ID = "sfx";

// ---------------------------------------------------------------------------
// Client (injectable, so tests use a mock)

export type SpeechRequest = { voiceId: string; text: string; modelId: string; outputFormat: string };
export type SoundRequest = {
  text: string;
  durationSeconds: number;
  loop: boolean;
  modelId: string;
  outputFormat: string;
};

/** The two ElevenLabs calls the app makes. Tests pass a mock; `elevenLabsVoiceClient` wraps the SDK. */
export interface VoiceClient {
  speech(req: SpeechRequest): Promise<Uint8Array>;
  sound(req: SoundRequest): Promise<Uint8Array>;
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The SDK client as a `VoiceClient`. */
export function elevenLabsVoiceClient(client: ElevenLabsClient): VoiceClient {
  return {
    async speech({ voiceId, text, modelId, outputFormat }) {
      const audio = await client.textToSpeech.convert(
        voiceId,
        { text, modelId, outputFormat: outputFormat as "mp3_44100_64" },
        { timeoutInSeconds: 60, maxRetries: 1 },
      );
      return bytes(audio);
    },
    async sound({ text, durationSeconds, loop, modelId, outputFormat }) {
      const audio = await client.textToSoundEffects.convert(
        { text, durationSeconds, loop, modelId: modelId as "eleven_text_to_sound_v2", outputFormat: outputFormat as "mp3_44100_128" },
        { timeoutInSeconds: 90, maxRetries: 1 },
      );
      return bytes(audio);
    },
  };
}

const g = globalThis as typeof globalThis & {
  __forkingPathsVoiceClient?: { key: string; client: VoiceClient };
  __forkingPathsVoiceClientOverride?: VoiceClient | null;
  __forkingPathsVoiceInflight?: Map<string, Promise<SpeakResult>>;
  __forkingPathsQuestVoiceInflight?: Map<string, Promise<QuestVoice>>;
};

/** Makes every voice call use `client` (tests). `null` = no client; undefined restores the default. */
export function setVoiceClient(client: VoiceClient | null | undefined): void {
  g.__forkingPathsVoiceClientOverride = client;
}

/** The client: the override, else the SDK when ELEVENLABS_API_KEY is set, else null. */
export function getVoiceClient(env: NodeJS.ProcessEnv = process.env): VoiceClient | null {
  if (g.__forkingPathsVoiceClientOverride !== undefined) return g.__forkingPathsVoiceClientOverride;
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return null;
  // The cache key is a hash, so the key itself is never kept in a readable form.
  const key = createHash("sha256").update(apiKey).digest("hex");
  if (g.__forkingPathsVoiceClient?.key !== key) {
    g.__forkingPathsVoiceClient = { key, client: elevenLabsVoiceClient(new ElevenLabsClient({ apiKey })) };
  }
  return g.__forkingPathsVoiceClient.client;
}

// ---------------------------------------------------------------------------
// Configuration

export type VoiceConfig = {
  /** The narrator voice: ELEVENLABS_VOICE_ID, else the voice of the static clips, else none. */
  voiceId: string | null;
  /** ELEVENLABS_MODEL_ID, else the static clips' model, else eleven_v4. */
  modelId: string;
  /** ELEVENLABS_LIVE=1: the app may call ElevenLabs. */
  live: boolean;
};

export function voiceConfig(env: NodeJS.ProcessEnv = process.env, staticDir: StaticDir = STATIC_AUDIO_DIR): VoiceConfig {
  const manifest = readStaticManifest(staticDir);
  return {
    voiceId: env.ELEVENLABS_VOICE_ID?.trim() || manifest?.voiceId || null,
    modelId: env.ELEVENLABS_MODEL_ID?.trim() || manifest?.modelId || DEFAULT_TTS_MODEL,
    live: /^(1|true|yes|on)$/i.test(env.ELEVENLABS_LIVE?.trim() ?? ""),
  };
}

export type VoiceOptions = {
  /** The line's language. The model reads the language from the text; this is kept for logs and later use. */
  lang?: Lang;
  store?: Store;
  /** Default: `getVoiceClient(env)`. Null: never call ElevenLabs. */
  client?: VoiceClient | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** May new lines be voiced? Default: ELEVENLABS_LIVE. Scripts pass true. */
  live?: boolean;
  /** Take characters from today's `tts-chars` budget. Default true; scripts pass false. */
  budget?: boolean;
  /** Where static clips live (default `public/audio`); null skips them. */
  staticDir?: StaticDir;
};

type Resolved = {
  store: Store;
  client: VoiceClient | null;
  config: VoiceConfig;
  live: boolean;
  budget: boolean;
  staticDir: StaticDir;
  env: NodeJS.ProcessEnv;
  now?: Date;
};

function resolve(opts: VoiceOptions): Resolved {
  const env = opts.env ?? process.env;
  const staticDir = opts.staticDir === undefined ? STATIC_AUDIO_DIR : opts.staticDir;
  const config = voiceConfig(env, staticDir);
  return {
    store: opts.store ?? getStore(),
    client: opts.client === undefined ? getVoiceClient(env) : opts.client,
    config,
    live: opts.live ?? config.live,
    budget: opts.budget ?? true,
    staticDir,
    env,
    now: opts.now,
  };
}

// ---------------------------------------------------------------------------
// Text

/** A clip id: the first 32 hex characters of sha256(model, voice, text). */
export function clipIdFor(text: string, voiceId: string, modelId: string): string {
  return createHash("sha256").update(`${modelId}\n${voiceId}\n${text}`).digest("hex").slice(0, 32);
}

/** v4 audio tags: a short word or two in square brackets, e.g. `[whispers]`. */
const AUDIO_TAG = /\[[A-Za-z][A-Za-z' -]{0,30}\]/g;

/** The line as the screen shows it: audio tags removed, spacing tidied. */
export function displayText(text: string): string {
  return text
    .replace(AUDIO_TAG, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?…])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/** A line for an API response: the text the screen shows, and the clip when there is one. */
export function spokenLine(text: string, clipId?: string | null): SpokenLine {
  return clipId ? { text: displayText(text), clipId } : { text: displayText(text) };
}

/** Characters a line costs (ElevenLabs bills the text it is sent, tags included). */
export function ttsChars(text: string): number {
  return text.trim().length;
}

// ---------------------------------------------------------------------------
// Clips

async function clipExists(id: string, r: Resolved): Promise<boolean> {
  if (await r.store.getClip(id)) return true;
  return hasStaticClip(id, r.staticDir);
}

/** A clip's mp3: from the store, else from `public/audio`. Null when it does not exist. */
export async function readClipAudio(
  id: string,
  opts: Pick<VoiceOptions, "store" | "staticDir"> = {},
): Promise<Uint8Array | null> {
  const store = opts.store ?? getStore();
  const staticDir = opts.staticDir === undefined ? STATIC_AUDIO_DIR : opts.staticDir;
  let stored: Uint8Array | null = null;
  try {
    stored = (await store.getClip(id))?.mp3 ?? null;
  } catch (err) {
    console.warn(`voice: clip store unavailable (${(err as Error).message}); trying static clips`);
  }
  return stored ?? readStaticClip(id, staticDir);
}

function inflight(): Map<string, Promise<SpeakResult>> {
  return (g.__forkingPathsVoiceInflight ??= new Map());
}

/**
 * Runs `work` once per key at a time: a second caller with the same key waits for the first
 * and gets its result without the cost (`charsSpent: 0`). Keys are set before any await.
 */
function once(key: string, work: () => Promise<SpeakResult>): Promise<SpeakResult> {
  const running = inflight();
  const pending = running.get(key);
  if (pending) return pending.then((res) => ({ ...res, charsSpent: 0 }));
  const job = work().finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

/** Voices one line with no budget check (the caller took it) and stores the clip. */
async function synthesise(text: string, id: string, voiceId: string, r: Resolved): Promise<void> {
  if (await clipExists(id, r)) return;
  const client = r.client!;
  const mp3 = await withSpan(
    "voice.tts",
    { role: "narrator", model: r.config.modelId },
    () => client.speech({ voiceId, text, modelId: r.config.modelId, outputFormat: TTS_OUTPUT_FORMAT }),
    { op: "ai.tts" },
  );
  if (mp3.byteLength === 0) throw new Error("ElevenLabs returned no audio");
  await r.store.putClip({ id, text, voiceId, modelId: r.config.modelId, mp3 });
}

export type VoiceOff =
  | "no-voice" // no ELEVENLABS_VOICE_ID and no static clips
  | "no-key" // no ELEVENLABS_API_KEY
  | "not-live" // ELEVENLABS_LIVE is not set
  | "over-cap" // today's tts-chars budget would be passed
  | "error"; // ElevenLabs or the clip store failed

export type SpeakResult = { clipId: string | null; reason?: VoiceOff; charsSpent: number };

/**
 * Voices one line (a bridge line during the walk) and returns its clip id, or null: then the
 * screen shows the text. A cached line costs nothing. Otherwise it takes the line's
 * characters from today's budget first; over the cap it makes no request.
 */
export async function speak(text: string, opts: VoiceOptions = {}): Promise<string | null> {
  return (await speakDetailed(text, opts)).clipId;
}

/** `speak`, with why there is no clip and what it cost. Never throws. */
export function speakDetailed(text: string, opts: VoiceOptions = {}): Promise<SpeakResult> {
  const r = resolve(opts);
  const line = text.trim();
  const voiceId = r.config.voiceId;
  if (!line || !voiceId) return Promise.resolve({ clipId: null, reason: "no-voice", charsSpent: 0 });
  const id = clipIdFor(line, voiceId, r.config.modelId);
  return once(id, async () => {
    let chars = 0;
    try {
      if (await clipExists(id, r)) return { clipId: id, charsSpent: 0 };
      if (!r.client) return { clipId: null, reason: "no-key", charsSpent: 0 };
      if (!r.live) return { clipId: null, reason: "not-live", charsSpent: 0 };
      if (r.budget) {
        const take = await budgetTake("tts-chars", ttsChars(line), { store: r.store, env: r.env, now: r.now });
        if (!take.ok) return { clipId: null, reason: "over-cap", charsSpent: 0 };
      }
      chars = ttsChars(line);
      await synthesise(line, id, voiceId, r);
      return { clipId: id, charsSpent: chars };
    } catch (err) {
      console.warn(`voice: a line could not be voiced (${(err as Error).message}); showing text`);
      return { clipId: null, reason: "error", charsSpent: chars };
    }
  });
}

// ---------------------------------------------------------------------------
// A quest's lines

export type { QuestLineKey } from "./audio-mix";

/** Every line voiced when a run starts, in play order per place. */
export function questLines(quest: Quest): { key: QuestLineKey; text: string }[] {
  const lines: { key: QuestLineKey; text: string }[] = [{ key: "briefing", text: quest.briefing.text }];
  for (const p of quest.places) {
    lines.push(
      { key: `${p.id}.clue`, text: p.clue.text },
      { key: `${p.id}.look`, text: p.look.text },
      { key: `${p.id}.hint`, text: p.hint.text },
      { key: `${p.id}.reveal`, text: p.reveal.text },
    );
  }
  lines.push({ key: "finale", text: quest.finale.text });
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text.length > 0);
}

/**
 * What voicing a quest would cost now, without calling ElevenLabs: every line, and the
 * characters of the lines not cached yet (same text twice is paid once).
 */
export async function questVoiceCost(
  quest: Quest,
  opts: Pick<VoiceOptions, "store" | "env" | "staticDir"> = {},
): Promise<{ voiceId: string | null; lines: number; chars: number; missing: number; missingChars: number }> {
  const r = resolve({ ...opts, client: null });
  const lines = questLines(quest);
  const unique = new Map(lines.map((l) => [l.text, ttsChars(l.text)]));
  const chars = [...unique.values()].reduce((a, b) => a + b, 0);
  const voiceId = r.config.voiceId;
  if (!voiceId) return { voiceId, lines: lines.length, chars, missing: unique.size, missingChars: chars };
  let missing = 0;
  let missingChars = 0;
  for (const [text, n] of unique) {
    if (!(await clipExists(clipIdFor(text, voiceId, r.config.modelId), r))) {
      missing += 1;
      missingChars += n;
    }
  }
  return { voiceId, lines: lines.length, chars, missing, missingChars };
}

export type QuestVoice = {
  /** True: the run has audio. False: text only (see `reason`). */
  voice: boolean;
  reason?: VoiceOff;
  /** Clip id per line key. Empty when `voice` is false. */
  clips: Partial<Record<QuestLineKey, string>>;
  /** The ambience and stingers that exist (made once by `scripts/make-sounds.ts`). Empty when `voice` is false. */
  sounds: SoundClips;
  /** Characters taken from the budget for this call (0 when every line was cached). */
  charsSpent: number;
  /** ElevenLabs requests made. */
  requests: number;
  /** Lines that ElevenLabs failed to voice (they show as text). */
  failed: QuestLineKey[];
};

/**
 * Voices a quest's briefing, each place's clue, look, hint and reveal, and the finale.
 * Call it when a run starts. Lines already voiced cost nothing. For the rest it checks the
 * daily budget first, for all of them at once: over the cap it makes no ElevenLabs request
 * and returns no clips, and the run is text only.
 */
export async function voiceQuest(quest: Quest, opts: VoiceOptions = {}): Promise<QuestVoice> {
  const r = resolve({ lang: quest.lang, ...opts });
  const voiceId = r.config.voiceId;
  if (!voiceId) return voiceOff("no-voice");
  const lines = questLines(quest).map((l) => ({ ...l, id: clipIdFor(l.text, voiceId, r.config.modelId) }));

  // Two runs of the same quest starting together: the second waits, then finds every line cached.
  const key = `quest:${createHash("sha256").update(lines.map((l) => l.id).join(",")).digest("hex")}`;
  const running = questsInflight();
  const pending = running.get(key);
  if (pending) {
    await pending.catch(() => undefined);
    return voiceQuest(quest, opts);
  }
  const job = voiceLines(lines, voiceId, r).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

/**
 * The audio fields of `POST /api/runs` (StartRunResponse) from a `voiceQuest` result: every clip
 * to preload, the ambience and the stingers. `voice` is false when the run is text only.
 */
export function runAudio(qv: QuestVoice): {
  voice: boolean;
  preload: string[];
  ambienceClipId?: string;
  stingers: { found?: string; notHere?: string };
} {
  if (!qv.voice) return { voice: false, preload: [], stingers: {} };
  const { ambience, found, notHere } = qv.sounds;
  const preload = [...new Set([...Object.values(qv.clips), ambience, found, notHere].filter((x): x is string => !!x))];
  return {
    voice: true,
    preload,
    ...(ambience ? { ambienceClipId: ambience } : {}),
    stingers: { ...(found ? { found } : {}), ...(notHere ? { notHere } : {}) },
  };
}

function voiceOff(reason: VoiceOff, extra: Partial<QuestVoice> = {}): QuestVoice {
  return { voice: false, reason, clips: {}, sounds: {}, charsSpent: 0, requests: 0, failed: [], ...extra };
}

function questsInflight(): Map<string, Promise<QuestVoice>> {
  return (g.__forkingPathsQuestVoiceInflight ??= new Map());
}

async function voiceLines(
  lines: { key: QuestLineKey; text: string; id: string }[],
  voiceId: string,
  r: Resolved,
): Promise<QuestVoice> {
  let charsSpent = 0;
  let requests = 0;
  try {
    const missing = new Map<string, string>(); // id → text
    for (const l of lines) {
      if (!missing.has(l.id) && !(await clipExists(l.id, r))) missing.set(l.id, l.text);
    }

    if (missing.size > 0) {
      if (!r.client) return voiceOff("no-key");
      if (!r.live) return voiceOff("not-live");
      const chars = [...missing.values()].reduce((n, t) => n + ttsChars(t), 0);
      if (r.budget) {
        const take = await budgetTake("tts-chars", chars, { store: r.store, env: r.env, now: r.now });
        if (!take.ok) return voiceOff("over-cap");
      }
      charsSpent = chars;
    }

    // Two at a time: the free plan allows only a few concurrent requests.
    const failedIds = new Set<string>();
    const queue = [...missing.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [id, text] = next;
        requests += 1;
        try {
          await synthesise(text, id, voiceId, r);
        } catch (err) {
          failedIds.add(id);
          console.warn(`voice: a quest line could not be voiced (${(err as Error).message}); showing text`);
        }
      }
    };
    await Promise.all([worker(), worker()]);

    const clips: QuestVoice["clips"] = {};
    const failed: QuestLineKey[] = [];
    for (const l of lines) {
      if (failedIds.has(l.id)) failed.push(l.key);
      else clips[l.key] = l.id;
    }
    if (Object.keys(clips).length === 0) return voiceOff("error", { charsSpent, requests, failed });
    return { voice: true, clips, sounds: await soundClips(r), charsSpent, requests, failed };
  } catch (err) {
    console.warn(`voice: the quest could not be voiced (${(err as Error).message}); showing text`);
    return voiceOff("error", { charsSpent, requests });
  }
}

// ---------------------------------------------------------------------------
// Sounds

export type SoundKind = "ambience" | "found" | "notHere";
export type SoundSpec = { text: string; durationSeconds: number; loop: boolean };
export type SoundClips = Partial<Record<SoundKind, string>>;

/**
 * The game's sounds. The ambience plays under the briefing and the clues only, never while
 * the player walks; the stingers play on a result.
 */
export const SOUNDS: Record<SoundKind, SoundSpec> = {
  ambience: {
    text:
      "Quiet Istanbul harbour at dusk, recorded from a stone quay: soft water lapping, a distant ferry " +
      "engine hum, a few faraway seagulls, light wind. No voices, no music, no traffic.",
    durationSeconds: 12,
    loop: true,
  },
  found: {
    text: "A short warm discovery chime: one soft brass bell and a gentle rising wooden marimba note. Calm and satisfying.",
    durationSeconds: 2,
    loop: false,
  },
  notHere: {
    text: "A short soft wooden knock followed by a gentle low descending two-note hum. Not harsh, not a buzzer.",
    durationSeconds: 1.5,
    loop: false,
  },
};

export function soundClipId(spec: SoundSpec): string {
  return clipIdFor(`${spec.text}\n${spec.durationSeconds}s${spec.loop ? " loop" : ""}`, SFX_VOICE_ID, SFX_MODEL);
}

/** The sounds that have been made (store or static), by kind. Never calls ElevenLabs. */
async function soundClips(r: Resolved): Promise<SoundClips> {
  const out: SoundClips = {};
  for (const kind of Object.keys(SOUNDS) as SoundKind[]) {
    const id = soundClipId(SOUNDS[kind]);
    if (await clipExists(id, r)) out[kind] = id;
  }
  return out;
}

/** The ambience and stinger clips that exist. */
export async function findSounds(opts: Pick<VoiceOptions, "store" | "staticDir"> = {}): Promise<SoundClips> {
  return soundClips(resolve({ ...opts, client: null }));
}

/**
 * Makes one sound once (scripts): cached → its id, no request. Sounds do not count against the
 * `tts-chars` budget; only `scripts/make-sounds.ts` makes them.
 */
export async function makeSound(
  kind: SoundKind,
  opts: VoiceOptions = {},
): Promise<{ clipId: string | null; reason?: VoiceOff; requested: boolean }> {
  const r = resolve(opts);
  const spec = SOUNDS[kind];
  const id = soundClipId(spec);
  if (await clipExists(id, r)) return { clipId: id, requested: false };
  if (!r.client) return { clipId: null, reason: "no-key", requested: false };
  if (!r.live) return { clipId: null, reason: "not-live", requested: false };
  const client = r.client;
  const mp3 = await withSpan(
    "voice.sound",
    { role: "narrator", model: SFX_MODEL },
    () => client.sound({ ...spec, modelId: SFX_MODEL, outputFormat: SFX_OUTPUT_FORMAT }),
    { op: "ai.sound" },
  );
  if (mp3.byteLength === 0) throw new Error("ElevenLabs returned no audio");
  await r.store.putClip({ id, text: spec.text, voiceId: SFX_VOICE_ID, modelId: SFX_MODEL, mp3 });
  return { clipId: id, requested: true };
}
