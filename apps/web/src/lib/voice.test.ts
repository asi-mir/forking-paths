import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threeStop } from "@/quest/__fixtures__";
import type { Quest } from "@/quest/schema";
import { validateQuest } from "@/quest/validate";
import { budgetStatus } from "./budget";
import { createMemoryStore, type Store } from "./store";
import {
  clipIdFor,
  displayText,
  findSounds,
  makeSound,
  questLines,
  questVoiceCost,
  readClipAudio,
  runAudio,
  soundClipId,
  SOUNDS,
  speak,
  speakDetailed,
  spokenLine,
  voiceConfig,
  voiceQuest,
  type SoundRequest,
  type SpeechRequest,
  type VoiceClient,
  type VoiceOptions,
} from "./voice";
import { readStaticManifest, writeStaticClips } from "./voice-static";

/** A mock ElevenLabs client: records every request and returns a few fake mp3 bytes. */
function mockClient(opts: { fail?: (text: string) => boolean; delayMs?: number } = {}) {
  const speech: SpeechRequest[] = [];
  const sound: SoundRequest[] = [];
  const client: VoiceClient = {
    async speech(req) {
      speech.push(req);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail?.(req.text)) throw new Error("mock failure");
      return new TextEncoder().encode(`mp3:${req.text}`);
    },
    async sound(req) {
      sound.push(req);
      return new Uint8Array([0xff, 0xfb, 1, 2, 3]);
    },
  };
  return { client, speech, sound };
}

const ENV = {
  ELEVENLABS_VOICE_ID: "voice-test",
  ELEVENLABS_MODEL_ID: "eleven_v4",
  BUDGET_TTS_CHARS_PER_DAY: "4000",
} as unknown as NodeJS.ProcessEnv;

function testQuest(): Quest {
  const f = threeStop();
  const res = validateQuest(f.writer, f.facts, f.candidates, f.opts);
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return { ...res.quest, id: "q-test" };
}

let store: Store;
let mock: ReturnType<typeof mockClient>;
let opts: VoiceOptions;

beforeEach(() => {
  store = createMemoryStore();
  mock = mockClient();
  opts = { store, client: mock.client, env: ENV, live: true, staticDir: null };
});

describe("clip ids and text", () => {
  it("hashes text, voice and model into a 32-hex id", () => {
    const id = clipIdFor("Lock your phone. Go.", "v1", "eleven_v4");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(clipIdFor("Lock your phone. Go.", "v1", "eleven_v4")).toBe(id);
    expect(clipIdFor("Lock your phone. Go!", "v1", "eleven_v4")).not.toBe(id);
    expect(clipIdFor("Lock your phone. Go.", "v2", "eleven_v4")).not.toBe(id);
    expect(clipIdFor("Lock your phone. Go.", "v1", "eleven_v3")).not.toBe(id);
  });

  it("strips audio tags from the text on screen", () => {
    expect(displayText("[whispers] The answer is under your feet.")).toBe("The answer is under your feet.");
    expect(displayText("Two things here keep a story… [curious] one you can read.")).toBe(
      "Two things here keep a story… one you can read.",
    );
    expect(displayText("Walk on [sighs] , slowly.")).toBe("Walk on, slowly.");
    expect(displayText("A sign reads [1908] above the door.")).toBe("A sign reads [1908] above the door.");
    expect(spokenLine("[excited] Found it.", "abc")).toEqual({ text: "Found it.", clipId: "abc" });
    expect(spokenLine("[excited] Found it.", null)).toEqual({ text: "Found it." });
  });

  it("lists the briefing, each place's four lines and the finale", () => {
    const q = testQuest();
    const keys = questLines(q).map((l) => l.key);
    expect(keys[0]).toBe("briefing");
    expect(keys.at(-1)).toBe("finale");
    expect(keys).toHaveLength(2 + q.places.length * 4);
    expect(keys).toContain(`${q.places[0].id}.reveal`);
  });

  it("reads the voice from the environment, and is not live unless ELEVENLABS_LIVE is set", () => {
    expect(voiceConfig(ENV, null)).toEqual({ voiceId: "voice-test", modelId: "eleven_v4", live: false });
    expect(voiceConfig({ ...ENV, ELEVENLABS_LIVE: "1" }, null).live).toBe(true);
    expect(voiceConfig({} as NodeJS.ProcessEnv, null)).toEqual({ voiceId: null, modelId: "eleven_v4", live: false });
  });
});

describe("speak", () => {
  it("makes one ElevenLabs request for two calls with the same text", async () => {
    const a = await speak("[whispers] Look up… higher.", opts);
    const b = await speak("[whispers] Look up… higher.", opts);
    expect(a).toBe(b);
    expect(a).toBe(clipIdFor("[whispers] Look up… higher.", "voice-test", "eleven_v4"));
    expect(mock.speech).toHaveLength(1);
    expect(mock.speech[0]).toMatchObject({ voiceId: "voice-test", modelId: "eleven_v4", text: "[whispers] Look up… higher." });
    expect((await store.getClip(a!))?.text).toBe("[whispers] Look up… higher.");
  });

  it("makes one request, and takes the budget once, for two calls at the same time", async () => {
    mock = mockClient({ delayMs: 20 });
    const o = { ...opts, client: mock.client };
    const [a, b] = await Promise.all([speakDetailed("Toward the water.", o), speakDetailed("Toward the water.", o)]);
    expect(a.clipId).toBe(b.clipId);
    expect(mock.speech).toHaveLength(1);
    expect(a.charsSpent + b.charsSpent).toBe("Toward the water.".length);
    expect((await budgetStatus("tts-chars", { store, env: ENV })).used).toBe("Toward the water.".length);
  });

  it("takes the line's characters from today's budget", async () => {
    await speak("Walk toward the water.", opts);
    expect((await budgetStatus("tts-chars", { store, env: ENV })).used).toBe("Walk toward the water.".length);
  });

  it("over the daily cap makes no request and returns no clip", async () => {
    const env = { ...ENV, BUDGET_TTS_CHARS_PER_DAY: "10" };
    const res = await speakDetailed("This line is longer than ten characters.", { ...opts, env });
    expect(res).toEqual({ clipId: null, reason: "over-cap", charsSpent: 0 });
    expect(mock.speech).toHaveLength(0);
  });

  it("without a key, a voice, or ELEVENLABS_LIVE makes no request", async () => {
    expect((await speakDetailed("Hello.", { ...opts, client: null })).reason).toBe("no-key");
    expect((await speakDetailed("Hello.", { ...opts, env: {} as NodeJS.ProcessEnv })).reason).toBe("no-voice");
    expect((await speakDetailed("Hello.", { ...opts, live: undefined })).reason).toBe("not-live");
    expect(mock.speech).toHaveLength(0);
  });

  it("plays a cached line without a key and without ELEVENLABS_LIVE", async () => {
    const id = await speak("Already voiced.", opts);
    expect(await speak("Already voiced.", { ...opts, client: null, live: false })).toBe(id);
    expect(mock.speech).toHaveLength(1);
  });

  it("returns no clip, and never throws, when ElevenLabs fails", async () => {
    mock = mockClient({ fail: () => true });
    const res = await speakDetailed("Fails.", { ...opts, client: mock.client });
    expect(res.clipId).toBeNull();
    expect(res.reason).toBe("error");
  });
});

describe("voiceQuest", () => {
  it("voices every line once, takes the budget once, and costs nothing the second time", async () => {
    const q = testQuest();
    const lines = questLines(q);
    const chars = [...new Map(lines.map((l) => [l.text, l.text.length])).values()].reduce((a, b) => a + b, 0);

    const first = await voiceQuest(q, opts);
    expect(first.voice).toBe(true);
    expect(Object.keys(first.clips)).toHaveLength(lines.length);
    expect(first.charsSpent).toBe(chars);
    expect(mock.speech).toHaveLength(first.requests);
    expect((await budgetStatus("tts-chars", { store, env: ENV })).used).toBe(chars);

    const second = await voiceQuest(q, opts);
    expect(second.clips).toEqual(first.clips);
    expect(second.charsSpent).toBe(0);
    expect(second.requests).toBe(0);
    expect(mock.speech).toHaveLength(first.requests);
  });

  it("over the daily cap makes no ElevenLabs request and returns no clips", async () => {
    const env = { ...ENV, BUDGET_TTS_CHARS_PER_DAY: "100" };
    const res = await voiceQuest(testQuest(), { ...opts, env });
    expect(res).toMatchObject({ voice: false, reason: "over-cap", clips: {}, sounds: {}, requests: 0, charsSpent: 0 });
    expect(mock.speech).toHaveLength(0);
    expect(mock.sound).toHaveLength(0);
    expect((await budgetStatus("tts-chars", { store, env })).used).toBe(0);
  });

  it("is text only, with no request, when not live and lines are missing", async () => {
    const res = await voiceQuest(testQuest(), { ...opts, live: false });
    expect(res).toMatchObject({ voice: false, reason: "not-live", clips: {} });
    expect(mock.speech).toHaveLength(0);
  });

  it("two runs starting together voice the quest once", async () => {
    mock = mockClient({ delayMs: 5 });
    const o = { ...opts, client: mock.client };
    const q = testQuest();
    const [a, b] = await Promise.all([voiceQuest(q, o), voiceQuest(q, o)]);
    expect(a.clips).toEqual(b.clips);
    expect(mock.speech).toHaveLength(a.requests + b.requests);
    expect(a.charsSpent + b.charsSpent).toBe(a.charsSpent || b.charsSpent);
    expect(new Set(mock.speech.map((r) => r.text)).size).toBe(mock.speech.length);
  });

  it("leaves a line that fails as text and keeps the rest", async () => {
    const q = testQuest();
    mock = mockClient({ fail: (t) => t === q.finale.text });
    const res = await voiceQuest(q, { ...opts, client: mock.client });
    expect(res.voice).toBe(true);
    expect(res.failed).toEqual(["finale"]);
    expect(res.clips.finale).toBeUndefined();
    expect(res.clips.briefing).toBeDefined();
  });

  it("returns the sounds that exist, and makes each sound once", async () => {
    const q = testQuest();
    expect((await voiceQuest(q, opts)).sounds).toEqual({});
    expect(await makeSound("found", opts)).toEqual({ clipId: soundClipId(SOUNDS.found), requested: true });
    expect(await makeSound("found", opts)).toEqual({ clipId: soundClipId(SOUNDS.found), requested: false });
    expect(mock.sound).toHaveLength(1);
    expect(mock.sound[0]).toMatchObject({ durationSeconds: SOUNDS.found.durationSeconds, loop: false });
    expect((await voiceQuest(q, opts)).sounds).toEqual({ found: soundClipId(SOUNDS.found) });
    expect(await findSounds({ store, staticDir: null })).toEqual({ found: soundClipId(SOUNDS.found) });
  });

  it("gives the ambience a loop of 10–15 seconds, and the stingers a few seconds", () => {
    expect(SOUNDS.ambience.loop).toBe(true);
    expect(SOUNDS.ambience.durationSeconds).toBeGreaterThanOrEqual(10);
    expect(SOUNDS.ambience.durationSeconds).toBeLessThanOrEqual(15);
    expect(SOUNDS.found.durationSeconds).toBeLessThanOrEqual(3);
    expect(SOUNDS.notHere.durationSeconds).toBeLessThanOrEqual(3);
  });
});

describe("questVoiceCost and runAudio", () => {
  it("counts what voicing would cost without a request, then nothing once voiced", async () => {
    const q = testQuest();
    const before = await questVoiceCost(q, { store, env: ENV, staticDir: null });
    expect(before.lines).toBe(questLines(q).length);
    expect(before.missingChars).toBe(before.chars);
    expect(mock.speech).toHaveLength(0);
    const res = await voiceQuest(q, opts);
    expect(res.charsSpent).toBe(before.missingChars);
    const after = await questVoiceCost(q, { store, env: ENV, staticDir: null });
    expect(after).toMatchObject({ missing: 0, missingChars: 0, chars: before.chars });
  });

  it("maps a voiced quest to the run's preload list, ambience and stingers", async () => {
    const q = testQuest();
    await makeSound("ambience", opts);
    await makeSound("found", opts);
    const audio = runAudio(await voiceQuest(q, opts));
    expect(audio.voice).toBe(true);
    expect(audio.ambienceClipId).toBe(soundClipId(SOUNDS.ambience));
    expect(audio.stingers).toEqual({ found: soundClipId(SOUNDS.found) });
    expect(audio.preload).toContain(audio.ambienceClipId);
    expect(new Set(audio.preload).size).toBe(audio.preload.length);
    expect(runAudio(await voiceQuest(q, { ...opts, env: {} as NodeJS.ProcessEnv }))).toEqual({
      voice: false,
      preload: [],
      stingers: {},
    });
  });
});

describe("static clips (public/audio)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fp-audio-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("voices a quest from exported clips with no key, no voice id and an empty store", async () => {
    const q = testQuest();
    await voiceQuest(q, opts);
    const entries = await Promise.all(
      questLines(q).map(async (l) => {
        const id = clipIdFor(l.text, "voice-test", "eleven_v4");
        return { id, kind: "line" as const, text: l.text, mp3: (await store.getClip(id))!.mp3 };
      }),
    );
    writeStaticClips(entries, { voiceId: "voice-test", modelId: "eleven_v4" }, dir);
    expect(readStaticManifest(dir)?.voiceId).toBe("voice-test");

    const fresh = createMemoryStore();
    const before = mock.speech.length;
    const res = await voiceQuest(q, { store: fresh, client: null, env: {} as NodeJS.ProcessEnv, staticDir: dir });
    expect(res.voice).toBe(true);
    expect(Object.keys(res.clips)).toHaveLength(questLines(q).length);
    expect(mock.speech).toHaveLength(before);
    const audio = await readClipAudio(res.clips.briefing!, { store: fresh, staticDir: dir });
    expect(new TextDecoder().decode(audio!)).toBe(`mp3:${q.briefing.text}`);
  });
});
