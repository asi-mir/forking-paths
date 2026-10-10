import { API } from "@/quest/api";
import { silentWav, synthClip } from "./synth";

/**
 * The run's audio, on the phone.
 *
 * - Every clip of the run is fetched when the run starts (`preloadClips`) and kept in Cache
 *   Storage, so a reload or a weak signal at a stop does not stop the narrator.
 * - One audio element speaks. A second one carries the ambience, which plays only under the
 *   briefing and the clues. A third plays the stingers on results.
 * - Speech starts only from a tap. Nothing plays in pocket mode or on a hidden page: the
 *   screen calls `stopAll`.
 * - The ambience level is set through Web Audio (a GainNode), because iOS Safari ignores
 *   `HTMLMediaElement.volume`. Without Web Audio, the element's volume is the fallback.
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
/** How long the ambience fades out after the line ends. */
const AMBIENCE_FADE_MS = 600;

type AudioContextCtor = typeof AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class Narrator {
  private speech: HTMLAudioElement;
  private ambience: HTMLAudioElement;
  private sfx: HTMLAudioElement;
  private unlocked = new WeakSet<HTMLAudioElement>();
  private listeners = new Set<() => void>();
  private state: NarratorState = { playing: null, ambience: false };
  private fade: ReturnType<typeof setInterval> | null = null;
  /** The ambience's level control (Web Audio), set up on the first tap. */
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
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
      // A pause event from the line before can arrive after the next line has started (one tap
      // stops a line and starts another): the element is playing again, so it is not the end.
      if (this.state.playing === null || !this.speech.paused) return;
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
    this.setUpGain();
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

  /**
   * Routes the ambience element through a GainNode, so its level holds on iOS. Runs from a tap
   * (an AudioContext may only start from one). Once routed, the element is heard only through
   * the context, so a failure here leaves the plain element (and its `volume`) in place.
   */
  private setUpGain() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const gain = ctx.createGain();
      gain.gain.value = AMBIENCE_VOLUME;
      ctx.createMediaElementSource(this.ambience).connect(gain).connect(ctx.destination);
      this.ambience.volume = 1;
      this.ctx = ctx;
      this.gain = gain;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
      this.gain = null;
    }
  }

  /** Speak a line (from a tap). `withAmbience` only for the briefing and the clues. */
  async play(clipId: string, opts: { withAmbience?: boolean; tag?: string } = {}) {
    const interrupting = !this.speech.paused;
    this.stopLine();
    if (opts.withAmbience) this.setUpGain();
    const url = await loadClip(clipId);
    if (!url) return false;
    // A play() in the same task as a pause() can be cancelled by that pause: let it land first.
    // The element was unlocked by an earlier tap, so playing a moment later is still allowed.
    if (interrupting) await new Promise((r) => setTimeout(r, 0));
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
    } catch (error) {
      // Chrome rejects a play() that follows a pause() in the same tap with AbortError, though
      // the line plays on. Only a line that is really not playing ends here.
      if ((error as DOMException)?.name === "AbortError" && !this.speech.paused && this.speech.src === url) return true;
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
    this.endFade();
    if (!this.ambience.paused) this.ambience.pause();
    if (this.state.ambience) this.set({ ambience: false });
    this.record({ kind: "stop", tag });
  }

  private async startAmbience(tag?: string) {
    if (!this.ambienceClipId) return;
    const url = await loadClip(this.ambienceClipId);
    if (!url || this.state.playing === null) return;
    this.endFade();
    this.unlocked.add(this.ambience);
    this.ambience.muted = false;
    if (this.ambience.src !== url) this.ambience.src = url;
    if (this.gain && this.ctx) {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setValueAtTime(AMBIENCE_VOLUME, this.ctx.currentTime);
      this.ambience.volume = 1;
    } else {
      this.ambience.volume = AMBIENCE_VOLUME;
    }
    this.set({ ambience: true });
    this.record({ kind: "ambience", clipId: this.ambienceClipId, tag });
    await this.ambience.play().catch(async (error: unknown) => {
      // A play() right after a pause() can be rejected with AbortError: try once more.
      if ((error as DOMException)?.name === "AbortError" && this.state.playing !== null) {
        if (!this.ambience.paused) return;
        await new Promise((r) => setTimeout(r, 0));
        if (this.state.playing !== null && (await this.ambience.play().then(() => true, () => false))) return;
      }
      this.set({ ambience: false });
    });
  }

  private endFade() {
    if (this.fade) {
      clearInterval(this.fade);
      clearTimeout(this.fade);
    }
    this.fade = null;
  }

  private stopAmbience() {
    if (!this.state.ambience || this.fade) return;
    const el = this.ambience;
    const finish = () => {
      el.pause();
      this.endFade();
      this.set({ ambience: false });
    };
    // A hidden page may never run the fade's timers (iOS suspends them): stop at once.
    if (typeof document !== "undefined" && document.hidden) return finish();
    if (this.gain && this.ctx && this.ctx.state === "running") {
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + AMBIENCE_FADE_MS / 1000);
      this.fade = setTimeout(finish, AMBIENCE_FADE_MS);
      return;
    }
    // Step count, not the volume, ends the fade: without Web Audio, iOS ignores `volume`.
    const steps = 12;
    let step = 0;
    this.fade = setInterval(() => {
      step += 1;
      el.volume = Math.max(0, AMBIENCE_VOLUME * (1 - step / steps));
      if (step >= steps) finish();
    }, AMBIENCE_FADE_MS / steps);
  }

  /** The run's ambience clip (known once the walk record is read). */
  setAmbience(clipId: string | undefined) {
    this.ambienceClipId = clipId;
  }

  dispose() {
    this.stopAll("dispose");
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.gain = null;
  }
}
