import { API } from "@/quest/api";
import { silentWav, synthClip } from "./synth";

/**
 * The run's audio, on the phone.
 *
 * - Every clip of the run is fetched when the run starts (`preloadClips`) and kept in Cache
 *   Storage, so a reload or a weak signal at a stop does not stop the narrator.
 * - One audio element speaks. A second one carries the ambience, which plays only under the
 *   briefing and the clues. A third plays the stingers on results.
 * - Speech starts only from a tap. Nothing plays in pocket mode: the screen calls `stopAll`.
 * - Every line is on screen as text too; a line without a clip is text only.
 */

const CACHE_NAME = "fp-audio-v1";
const urls = new Map<string, string>(); // clipId → blob URL
const loading = new Map<string, Promise<string | null>>();

async function fetchClip(clipId: string): Promise<Blob | null> {
  const synth = synthClip(clipId);
  if (synth) return new Blob([synth], { type: "audio/wav" });
  const url = API.audio(clipId);
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) return hit.blob();
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  await cache?.put(url, res.clone()).catch(() => undefined);
  return res.blob();
}

/** A playable URL for a clip, fetched once (null if it cannot be loaded: show the text). */
export function loadClip(clipId: string): Promise<string | null> {
  const ready = urls.get(clipId);
  if (ready) return Promise.resolve(ready);
  let p = loading.get(clipId);
  if (!p) {
    p = fetchClip(clipId)
      .then((blob) => {
        if (!blob) return null;
        const u = URL.createObjectURL(blob);
        urls.set(clipId, u);
        return u;
      })
      .catch(() => null)
      .finally(() => loading.delete(clipId));
    loading.set(clipId, p);
  }
  return p;
}

/** Fetch every clip of the run, four at a time. */
export async function preloadClips(
  ids: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ loaded: number; failed: number }> {
  const queue = [...new Set(ids)];
  let done = 0;
  let failed = 0;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (!(await loadClip(id))) failed += 1;
      done += 1;
      onProgress?.(done, ids.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { loaded: done - failed, failed };
}

// ---------------------------------------------------------------------------

export type AudioEvent = {
  t: number;
  kind: "speech" | "ambience" | "stinger" | "stop";
  clipId?: string;
  tag?: string; // the screen that asked for it
};

export type NarratorState = { playing: string | null; ambience: boolean };

const AMBIENCE_VOLUME = 0.22;

export class Narrator {
  private speech: HTMLAudioElement;
  private ambience: HTMLAudioElement;
  private sfx: HTMLAudioElement;
  private unlocked = new WeakSet<HTMLAudioElement>();
  private listeners = new Set<() => void>();
  private state: NarratorState = { playing: null, ambience: false };
  private fade: ReturnType<typeof setInterval> | null = null;
  private silent: string | null = null;
  /** Recent audio events, for the browser checks of the audio rules. */
  readonly log: AudioEvent[] = [];

  private ambienceClipId: string | undefined;

  constructor(ambienceClipId?: string) {
    this.ambienceClipId = ambienceClipId;
    this.speech = new Audio();
    this.ambience = new Audio();
    this.sfx = new Audio();
    this.ambience.loop = true;
    this.speech.preload = "auto";
    const done = () => {
      if (this.state.playing === null) return;
      this.set({ playing: null });
      this.stopAmbience();
    };
    this.speech.addEventListener("ended", done);
    this.speech.addEventListener("pause", done);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getState = () => this.state;

  /** Which elements are playing right now, for the browser checks of the audio rules. */
  paused = () => ({ speech: this.speech.paused, ambience: this.ambience.paused, sfx: this.sfx.paused });

  private set(patch: Partial<NarratorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private record(ev: Omit<AudioEvent, "t">) {
    this.log.push({ t: Date.now(), ...ev });
    if (this.log.length > 200) this.log.shift();
  }

  /**
   * Call from a tap: lets the elements not used yet play later without a tap (iOS needs one
   * user-started play per element). Plays a 50 ms silent clip on each.
   */
  unlock() {
    this.silent ??= URL.createObjectURL(new Blob([silentWav()], { type: "audio/wav" }));
    for (const el of [this.sfx, this.ambience, this.speech]) {
      if (this.unlocked.has(el) || !el.paused) continue;
      this.unlocked.add(el);
      el.muted = true;
      el.src = this.silent;
      el.play()
        .then(() => {
          if (el.src === this.silent) el.pause(); // a real clip may have started meanwhile
        })
        .catch(() => undefined)
        .finally(() => {
          el.muted = false;
        });
    }
  }

  /** Speak a line (from a tap). `withAmbience` only for the briefing and the clues. */
  async play(clipId: string, opts: { withAmbience?: boolean; tag?: string } = {}) {
    this.stopLine();
    const url = await loadClip(clipId);
    if (!url) return false;
    this.unlocked.add(this.speech);
    this.speech.muted = false;
    this.speech.src = url;
    this.speech.currentTime = 0;
    this.set({ playing: clipId });
    this.record({ kind: "speech", clipId, tag: opts.tag });
    if (opts.withAmbience) void this.startAmbience(opts.tag);
    try {
      await this.speech.play();
      return true;
    } catch {
      this.set({ playing: null });
      this.stopAmbience();
      return false;
    }
  }

  stopLine() {
    if (!this.speech.paused) this.speech.pause();
    if (this.state.playing !== null) this.set({ playing: null });
    this.stopAmbience();
  }

  /** A short sound on a result. Plays without a tap once `unlock` has run. */
  async stinger(clipId: string | undefined, tag?: string) {
    if (!clipId) return;
    const url = await loadClip(clipId);
    if (!url) return;
    this.sfx.muted = false;
    this.sfx.src = url;
    this.record({ kind: "stinger", clipId, tag });
    await this.sfx.play().catch(() => undefined);
  }

  /** Silence everything: pocket mode, leaving the page. */
  stopAll(tag?: string) {
    this.stopLine();
    if (!this.sfx.paused) this.sfx.pause();
    if (this.fade) clearInterval(this.fade);
    this.fade = null;
    if (!this.ambience.paused) this.ambience.pause();
    if (this.state.ambience) this.set({ ambience: false });
    this.record({ kind: "stop", tag });
  }

  private async startAmbience(tag?: string) {
    if (!this.ambienceClipId) return;
    const url = await loadClip(this.ambienceClipId);
    if (!url || this.state.playing === null) return;
    if (this.fade) clearInterval(this.fade);
    this.fade = null;
    this.unlocked.add(this.ambience);
    this.ambience.muted = false;
    if (this.ambience.src !== url) this.ambience.src = url;
    this.ambience.volume = AMBIENCE_VOLUME;
    this.set({ ambience: true });
    this.record({ kind: "ambience", clipId: this.ambienceClipId, tag });
    await this.ambience.play().catch(() => this.set({ ambience: false }));
  }

  private stopAmbience() {
    if (!this.state.ambience || this.fade) return;
    const el = this.ambience;
    // Step count, not the volume, ends the fade: iOS Safari ignores `volume` (it stays 1).
    const steps = 12;
    let step = 0;
    this.fade = setInterval(() => {
      step += 1;
      el.volume = Math.max(0, AMBIENCE_VOLUME * (1 - step / steps));
      if (step >= steps) {
        el.pause();
        if (this.fade) clearInterval(this.fade);
        this.fade = null;
        this.set({ ambience: false });
      }
    }, 50);
  }

  /** The run's ambience clip (known once the walk record is read). */
  setAmbience(clipId: string | undefined) {
    this.ambienceClipId = clipId;
  }

  dispose() {
    this.stopAll("dispose");
  }
}
