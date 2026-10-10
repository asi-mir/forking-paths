import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, setStore, type Store } from "@/lib/store";
import { setVoiceClient, type VoiceClient } from "@/lib/voice";
import type { ReaderInput, ReadResult } from "@/mastra/agents/reader";
import type { ModelCallMeta } from "@/lib/json";
import { FinishResponseSchema, PHOTO_MAX_BYTES, PhotoResultSchema, StartRunResponseSchema } from "./api";
import { reasonBridge } from "./bridge";
import { DEMO_QUEST_ID, demoQuest } from "./demo";
import { placeById } from "./routes";
import { beginRun, finishWalk, loadQuest, photoStep, warmLocalReader } from "./run-service";
import type { Verdict } from "./schema";

// The routes call the real photo check and fork rule; only Gemma is replaced (no network).
const reads: ReaderInput[] = [];
let nextVerdict: Verdict | Error = { plausible: true, confidence: 0.9, observed: "bronze spout over a stone basin", cue: "water" };
vi.mock("./photo-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./photo-check")>();
  return {
    ...real,
    checkPhoto: (input: Parameters<typeof real.checkPhoto>[0], options: Parameters<typeof real.checkPhoto>[1] = {}) =>
      real.checkPhoto(input, {
        ...options,
        env: { GEMMA_PROVIDER: "ollama" },
        read: async (i): Promise<ReadResult> => {
          reads.push(i);
          if (nextVerdict instanceof Error) throw nextVerdict;
          return { verdict: nextVerdict, meta: { latencyMs: 1234 } as ModelCallMeta, raw: { ...nextVerdict } };
        },
      }),
    chooseNext: (input: Parameters<typeof real.chooseNext>[0], options: Parameters<typeof real.chooseNext>[1] = {}) =>
      real.chooseNext(input, { ...options, byMeaning: async () => null, bridge: async (ctx) => reasonBridge(ctx.link, [], ctx) }),
  };
});

const { POST: startRoute } = await import("@/app/api/runs/route");
const { POST: photoRoute } = await import("@/app/api/runs/[runId]/photo/route");
const { POST: finishRoute } = await import("@/app/api/runs/[runId]/finish/route");

const quest = demoQuest();
const loc = (id: string) => placeById(quest, id)!.location;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });

const post = (body: unknown) =>
  new Request("http://localhost/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function photoRequest(runId: string, fields: Record<string, string>, image: Blob = new Blob([JPEG], { type: "image/jpeg" })) {
  const form = new FormData();
  form.set("image", image, "photo.jpg");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://localhost/api/runs/${runId}/photo`, { method: "POST", body: form });
}

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  setVoiceClient(null); // never ElevenLabs in tests
  reads.length = 0;
  nextVerdict = { plausible: true, confidence: 0.9, observed: "bronze spout over a stone basin", cue: "water" };
});
afterEach(() => setStore(undefined));
afterAll(() => setVoiceClient(undefined));

async function start(): Promise<string> {
  const res = await startRoute(post({ questId: DEMO_QUEST_ID }));
  expect(res.status).toBe(200);
  return StartRunResponseSchema.parse(await res.json()).runId;
}

describe("POST /api/runs", () => {
  it("starts the demo quest from its fixture, saves it, and is text only without voice", async () => {
    const res = await startRoute(post({ questId: DEMO_QUEST_ID }));
    const body = StartRunResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ questId: DEMO_QUEST_ID, voice: false, preload: [], first: { placeId: "P1", stop: 1, of: 3, isFork: true } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await store.getQuest(DEMO_QUEST_ID)).not.toBeNull(); // seeded
    const run = await store.getRun(body.runId);
    expect(run).toMatchObject({ questId: DEMO_QUEST_ID, path: [], voice: { on: false, clips: {} } });
  });

  it("answers 404 for an unknown quest and 400 for a bad body", async () => {
    expect((await startRoute(post({ questId: "nope" }))).status).toBe(404);
    expect(await (await startRoute(post({ questId: "nope" }))).json()).toMatchObject({ code: "not-found" });
    expect((await startRoute(post({}))).status).toBe(400);
    const notJson = new Request("http://localhost/api/runs", { method: "POST", body: "questId=x" });
    expect((await startRoute(notJson)).status).toBe(400);
  });
});

describe("POST /api/runs/[runId]/photo", () => {
  it("plays the whole walk: too far once, then the water branch, the finale and the case file", async () => {
    const runId = await start();
    const P1 = loc("P1");

    const far = await photoRoute(photoRequest(runId, { placeId: "P1", lat: String(P1.lat + 0.004), lng: String(P1.lng), accuracy: "10" }), ctx(runId));
    const farBody = PhotoResultSchema.parse(await far.json());
    expect(farBody).toMatchObject({ status: "too-far", retriesLeft: 1, hint: { direction: "S" } });
    expect(reads).toHaveLength(0);

    const r1 = PhotoResultSchema.parse(
      await (await photoRoute(photoRequest(runId, { placeId: "P1", lat: String(P1.lat), lng: String(P1.lng), accuracy: "8" }), ctx(runId))).json(),
    );
    expect(r1).toMatchObject({ status: "passed", next: { chosenBy: "cue", stop: { placeId: "P3", stop: 2 } } });
    expect(reads[0]).toMatchObject({ placeName: "Bereketzade Fountain", cues: ["writing", "water"] });
    expect(reads[0].image.mediaType).toBe("image/jpeg");
    // The phone learns which Gemma read the photo, and where, for the receipt.
    if (r1.status !== "passed") throw new Error(`expected passed, got ${r1.status}`);
    expect(r1.verdict?.checkedBy).toEqual({ provider: "ollama", model: "gemma4:e4b" });

    nextVerdict = { plausible: true, confidence: 0.85, observed: "marble basin under a pointed arch", cue: null };
    const P3 = loc("P3");
    const r2 = PhotoResultSchema.parse(
      await (await photoRoute(photoRequest(runId, { placeId: "P3", lat: String(P3.lat), lng: String(P3.lng) }), ctx(runId))).json(),
    );
    expect(r2).toMatchObject({ status: "passed", next: { chosenBy: "only-link", stop: { placeId: "P4", stop: 3 } } });

    // Desk-style: no GPS, the reader decides.
    const r3 = PhotoResultSchema.parse(await (await photoRoute(photoRequest(runId, { placeId: "P4" }), ctx(runId))).json());
    if (r3.status !== "passed") throw new Error(`expected passed, got ${r3.status}`);
    expect(r3.end!.caseFile.route.map((s) => s.placeId)).toEqual(["P1", "P3", "P4"]);
    expect(r3.end!.caseFile.notTaken[0]).toMatchObject({ at: "P1", taken: { to: "P3" }, notTaken: [{ to: "P2", cue: "writing" }] });

    const attempts = await store.attemptsFor(runId);
    expect(attempts.map((a) => [a.placeId, a.passed])).toEqual([
      ["P1", false],
      ["P1", true],
      ["P3", true],
      ["P4", true],
    ]);
    expect(attempts[1]).toMatchObject({ provider: "ollama/gemma4:e4b", latencyMs: 1234, distanceM: 0, accuracyM: 8 });
    expect(attempts[3]).toMatchObject({ distanceM: null, accuracyM: null });
    // Nothing that was stored holds the photo.
    const stored = JSON.stringify({ attempts, run: await store.getRun(runId) });
    expect(stored).not.toMatch(/image|255,216/);

    // Finish, twice: the first receipt is kept.
    const receipt = { screenOnMs: 90_000, pocketMs: 810_000, peeks: 2 };
    const fin = FinishResponseSchema.parse(
      await (await finishRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ receipt }) }), ctx(runId))).json(),
    );
    expect(fin).toEqual({ runId, stopsFound: 3, score: 300 - 20 + 50, screenOnShare: 0.1, receipt });
    const again = await finishRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ receipt: { screenOnMs: 1, pocketMs: 1, peeks: 0 } }) }), ctx(runId));
    expect(FinishResponseSchema.parse(await again.json()).receipt).toEqual(receipt);
  });

  it("refuses bad uploads before any model call", async () => {
    const runId = await start();
    const gif = new Blob([new TextEncoder().encode("GIF89a")], { type: "image/gif" });
    expect((await photoRoute(photoRequest(runId, { placeId: "P1" }, gif), ctx(runId))).status).toBe(400);
    const fakeJpeg = new Blob([new TextEncoder().encode("<svg>")], { type: "image/jpeg" });
    expect((await photoRoute(photoRequest(runId, { placeId: "P1" }, fakeJpeg), ctx(runId))).status).toBe(415);
    const big = new Blob([JPEG, new Uint8Array(PHOTO_MAX_BYTES)], { type: "image/jpeg" });
    expect((await photoRoute(photoRequest(runId, { placeId: "P1" }, big), ctx(runId))).status).toBe(413);
    expect((await photoRoute(photoRequest(runId, { placeId: "P1", lat: "abc", lng: "28.9" }), ctx(runId))).status).toBe(400);
    expect((await photoRoute(photoRequest(runId, { placeId: "P1", lat: "41.02" }), ctx(runId))).status).toBe(400);
    const json = new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await photoRoute(json, ctx(runId))).status).toBe(415);
    expect(reads).toHaveLength(0);
    expect(await store.attemptsFor(runId)).toEqual([]);
  });

  it("answers 404 for an unknown run, 409 for another stop, and 503 when the reader is down without GPS", async () => {
    expect((await photoRoute(photoRequest("nope", { placeId: "P1" }), ctx("nope"))).status).toBe(404);
    const runId = await start();
    const wrong = await photoRoute(photoRequest(runId, { placeId: "P4" }), ctx(runId));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: "wrong-place" });
    nextVerdict = new Error("connect ECONNREFUSED");
    const down = await photoRoute(photoRequest(runId, { placeId: "P1" }), ctx(runId));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "reader-unavailable" });
    expect(await store.attemptsFor(runId)).toHaveLength(1);
  });

  it("sends the same answer again for a stop already done (a lost response)", async () => {
    const runId = await start();
    const P1 = loc("P1");
    const req = () => photoRequest(runId, { placeId: "P1", lat: String(P1.lat), lng: String(P1.lng) });
    const first = await (await photoRoute(req(), ctx(runId))).json();
    const second = await (await photoRoute(req(), ctx(runId))).json();
    expect(second).toEqual(first);
    expect(reads).toHaveLength(1);
  });
});

describe("run service", () => {
  it("plays the demo quest from its fixture when the store is down", async () => {
    const broken = { ...createMemoryStore(), getQuest: async () => Promise.reject(new Error("no server")) } as Store;
    await expect(loadQuest(DEMO_QUEST_ID, { store: broken })).resolves.toMatchObject({ id: DEMO_QUEST_ID });
    await expect(loadQuest("other", { store: broken })).rejects.toThrow("no server");
  });

  it("never plays a quest that failed validation", async () => {
    const q = await store.saveQuest({ ...demoQuest(), id: "failed-1", status: "failed" });
    await expect(loadQuest(q.id, { store })).rejects.toMatchObject({ code: "not-ready" });
  });

  it("voices the quest at start through voiceQuest, and the bridge line on the way", async () => {
    const spoken: string[] = [];
    const client: VoiceClient = {
      speech: async (r) => {
        spoken.push(r.text);
        return new Uint8Array([1, 2, 3]);
      },
      sound: async () => new Uint8Array([4]),
    };
    const voice = { client, live: true, staticDir: null, env: { NODE_ENV: "test", ELEVENLABS_VOICE_ID: "voice-1", BUDGET_TTS_CHARS_PER_DAY: "100000" } as NodeJS.ProcessEnv };
    const start = await beginRun(DEMO_QUEST_ID, "test-agent", { store, voice });
    expect(start.voice).toBe(true);
    expect(start.briefing.clipId).toBeDefined();
    expect(start.first.clue.clipId).toBeDefined();
    expect(start.preload.length).toBeGreaterThanOrEqual(18);
    const lines = spoken.length;

    const P1 = loc("P1");
    const r = await photoStep(start.runId, { placeId: "P1", image: { data: JPEG, mediaType: "image/jpeg" }, position: { ...P1, accuracyM: 5 } }, { store, voice });
    if (r.status !== "passed") throw new Error("expected passed");
    expect(r.reveal.line.clipId).toBeDefined();
    expect(r.next!.bridge.line.clipId).toBeDefined();
    expect(spoken.length).toBe(lines + 1); // only the bridge line is voiced during the walk

    const over = await beginRun(DEMO_QUEST_ID, undefined, { store: createMemoryStore(), voice: { ...voice, env: { ...voice.env, BUDGET_TTS_CHARS_PER_DAY: "10" } as NodeJS.ProcessEnv } });
    expect(over).toMatchObject({ voice: false, preload: [], stingers: {} });
  });

  it("finish answers 404 for an unknown run", async () => {
    await expect(finishWalk("nope", { screenOnMs: 0, pocketMs: 0, peeks: 0 }, { store })).rejects.toMatchObject({ status: 404 });
  });
});

describe("warmLocalReader", () => {
  it("loads the Ollama reader once a minute, and never calls Google", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const ollama = { GEMMA_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1", OLLAMA_MODEL: "gemma4:e4b" };
    const t = Date.now() + 3_600_000;
    expect(warmLocalReader(ollama, fake, t)).toBe(true);
    expect(warmLocalReader(ollama, fake, t + 1000)).toBe(false);
    expect(warmLocalReader({ GEMMA_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: "x" }, fake, t + 120_000)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("http://127.0.0.1:11434/api/generate");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ model: "gemma4:e4b", keep_alive: "30m" });
    expect(new Headers(calls[0][1]?.headers).has("authorization")).toBe(false);
  });

  it("sends OLLAMA_AUTH_HEADER to a protected tunnel", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const env = {
      GEMMA_READER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "https://gemma.tunnel.test/v1",
      OLLAMA_AUTH_HEADER: "Basic dGVzdDpub3QtcmVhbA==",
    };
    expect(warmLocalReader(env, fake, Date.now() + 7_200_000)).toBe(true);
    expect(calls[0][0]).toBe("https://gemma.tunnel.test/api/generate");
    expect(new Headers(calls[0][1]?.headers).get("authorization")).toBe("Basic dGVzdDpub3QtcmVhbA==");
  });
});
