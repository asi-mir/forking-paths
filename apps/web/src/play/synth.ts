/**
 * Tiny WAV synthesiser for the mock adapter's clip IDs (mock:speech:<s>:<hash>, mock:ambience,
 * mock:found, mock:not-here), so the audio rules can be heard and tested without a voice
 * provider. Pure: returns WAV bytes.
 */

const RATE = 16_000;

function wav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return bytes;
}

const fill = (seconds: number, f: (t: number, i: number) => number) => {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = f(i / RATE, i);
  return out;
};

const env = (t: number, dur: number, attack = 0.02, release = 0.25) =>
  Math.min(1, t / attack) * Math.min(1, Math.max(0, (dur - t) / release));

function tones(notes: Array<[hz: number, at: number, dur: number]>, total: number) {
  return fill(total, (t) =>
    notes.reduce((sum, [hz, at, dur]) => {
      const local = t - at;
      if (local < 0 || local > dur) return sum;
      return sum + 0.35 * env(local, dur, 0.01, dur * 0.8) * Math.sin(2 * Math.PI * hz * local);
    }, 0),
  );
}

/** A soft, voice-like murmur: a low tone whose loudness moves like syllables. */
function murmur(seconds: number) {
  return fill(seconds, (t) => {
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.2 * t) * Math.sin(2 * Math.PI * 0.7 * t + 1);
    const pitch = 150 + 20 * Math.sin(2 * Math.PI * 0.5 * t);
    return 0.18 * env(t, seconds, 0.05, 0.3) * syllable * Math.sin(2 * Math.PI * pitch * t);
  });
}

/** Brown noise, quiet, looped under the briefing and clues. */
function ambience(seconds: number) {
  let last = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return fill(seconds, (t) => {
    last = (last + 0.02 * rand()) / 1.02;
    const edge = Math.min(1, t / 0.3, (seconds - t) / 0.3);
    return 2.5 * last * edge;
  });
}

/** WAV bytes for a mock clip ID, or null when the ID is not a mock clip. */
export function synthClip(clipId: string): Uint8Array<ArrayBuffer> | null {
  if (clipId === "mock:ambience") return wav(ambience(6));
  if (clipId === "mock:found") return wav(tones([[660, 0, 0.35], [990, 0.16, 0.6]], 0.9));
  if (clipId === "mock:not-here") return wav(tones([[330, 0, 0.35], [247, 0.2, 0.55]], 0.9));
  const m = /^mock:speech:(\d+):/.exec(clipId);
  if (m) return wav(murmur(Number(m[1])));
  return null;
}

/** A short silent WAV, used to unlock audio elements from a tap (mobile browsers). */
export function silentWav(): Uint8Array<ArrayBuffer> {
  return wav(new Float32Array(Math.round(RATE * 0.05)));
}
