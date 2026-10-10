import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, setStore } from "@/lib/store";
import { clipIdFor, questLines, setVoiceClient, soundClipId, SOUNDS } from "@/lib/voice";
import { readStaticManifest } from "@/lib/voice-static";
import type { ReadResult } from "@/mastra/agents/reader";
import type { ModelCallMeta } from "@/lib/json";
import { PhotoResultSchema, QuestLineResponseSchema, QuestViewSchema, StartRunResponseSchema } from "./api";
import { reasonBridge } from "./bridge";
import { DEMO_QUEST_ID, demoQuest } from "./demo";
import { DESK_QUEST_ID, deskSamplesFor, demoSamples, samplesFor } from "./demo-samples";
import { sha256Hex, storedVerdictFor, storedVerdicts } from "./demo-stored";
import { pickNext } from "./fork";
import { lineText, questView } from "./quest-view";
import { placeById } from "./routes";
import type { Verdict } from "./schema";

// The committed desk-demo clips in public/audio stay out of these checks: voice is off here.
vi.mock("@/lib/voice-static", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-static")>()),
  STATIC_AUDIO_DIR: null,
}));

// The routes run the real photo check and fork rule; only Gemma is replaced (no network).
let nextRead: Verdict | Error = new Error("429 Too Many Requests");
vi.mock("./photo-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./photo-check")>();
  return {
    ...real,
    checkPhoto: (input: Parameters<typeof real.checkPhoto>[0], options: Parameters<typeof real.checkPhoto>[1] = {}) =>
      real.checkPhoto(input, {
        ...options,
        env: { GEMMA_PROVIDER: "ollama" },
        read: async (): Promise<ReadResult> => {
          if (nextRead instanceof Error) throw nextRead;
          return { verdict: nextRead, meta: { latencyMs: 900 } as ModelCallMeta, raw: { ...nextRead } };
        },
      }),
    chooseNext: (input: Parameters<typeof real.chooseNext>[0], options: Parameters<typeof real.chooseNext>[1] = {}) =>
      real.chooseNext(input, { ...options, byMeaning: async () => null, bridge: async (ctx) => reasonBridge(ctx.link, [], ctx) }),
  };
});

const { POST: startRoute } = await import("@/app/api/runs/route");
const { POST: photoRoute } = await import("@/app/api/runs/[runId]/photo/route");
const { GET: questRoute } = await import("@/app/api/quests/[questId]/route");
const { POST: lineRoute } = await import("@/app/api/quests/[questId]/line/route");

const quest = demoQuest();
const PUBLIC = join(process.cwd(), "public/demo");
const bytes = (file: string) => new Uint8Array(readFileSync(join(PUBLIC, file)));

beforeEach(() => {
  setStore(createMemoryStore());
  setVoiceClient(null); // never ElevenLabs in tests
  nextRead = new Error("429 Too Many Requests");
});
afterEach(() => setStore(undefined));
afterAll(() => setVoiceClient(undefined));

describe("desk demo sample photos", () => {
  it("cover every stop of the demo quest; the fork has two, one per cue of its links", () => {
    expect(DESK_QUEST_ID).toBe(DEMO_QUEST_ID);
    for (const place of quest.places) expect(samplesFor(place.id).length).toBeGreaterThan(0);
    const fork = placeById(quest, quest.startPlaceId)!;
    const atFork = samplesFor(fork.id);
    expect(atFork.map((s) => s.cue).sort()).toEqual(fork.links.map((l) => l.cue).sort());
    expect(deskSamplesFor("some-other-quest", fork.id)).toEqual([]);
  });

  it("are files in public/demo with credits, at most 1024 px, matching their sha256", () => {
    for (const s of demoSamples()) {
      expect(existsSync(join(PUBLIC, s.file))).toBe(true);
      expect(sha256Hex(bytes(s.file))).toBe(s.sha256);
      expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1024);
      expect(s.filePage).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(s.author.length).toBeGreaterThan(0);
    }
  });

  it("each have a stored verdict that passes with GPS missing; the fork's two lead to two different stops", async () => {
    const stored = storedVerdicts();
    for (const s of demoSamples()) {
      const v = stored.samples[s.id]?.verdict;
      expect(v, s.id).toBeDefined();
      expect(v!.plausible && v!.confidence >= 0.7).toBe(true);
      if (s.cue) expect(v!.cue).toBe(s.cue);
    }
    const next = await Promise.all(
      samplesFor("P1").map(async (s) => (await pickNext(quest, "P1", stored.samples[s.id].verdict, { byMeaning: async () => null })).link.to),
    );
    expect(new Set(next).size).toBe(2);
  });

  it("give a stored verdict only for the exact file, at its own stop, in the demo quest", () => {
    const water = samplesFor("P1").find((s) => s.cue === "water")!;
    const image = bytes(water.file);
    const ok = { questId: DEMO_QUEST_ID, placeId: "P1", sampleId: water.id, image };
    expect(storedVerdictFor(ok)?.cue).toBe("water");
    expect(storedVerdictFor({ ...ok, image: new Uint8Array([0xff, 0xd8, 0xff, 1]) })).toBeNull(); // another photo
    expect(storedVerdictFor({ ...ok, placeId: "P2" })).toBeNull(); // the wrong stop
    expect(storedVerdictFor({ ...ok, questId: "q-123" })).toBeNull(); // another quest
    expect(storedVerdictFor({ ...ok, sampleId: null })).toBeNull();
  });
});

async function startDesk(): Promise<string> {
  const res = await startRoute(
    new Request("http://localhost/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questId: DEMO_QUEST_ID }) }),
  );
  return StartRunResponseSchema.parse(await res.json()).runId;
}

function send(runId: string, file: string, sampleId?: string, data?: Uint8Array) {
  const form = new FormData();
  form.set("image", new Blob([(data ?? bytes(file)) as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), "photo.jpg");
  form.set("placeId", "P1");
  if (sampleId) form.set("sampleId", sampleId);
  return photoRoute(new Request(`http://localhost/api/runs/${runId}/photo`, { method: "POST", body: form }), { params: Promise.resolve({ runId }) });
}

describe("POST /api/runs/[runId]/photo in the desk demo (GPS missing)", () => {
  it("uses the stored result, labelled stored, when the live reader is rate-limited", async () => {
    const runId = await startDesk();
    const res = await send(runId, "p1-water.jpg", "p1-water");
    expect(res.status).toBe(200);
    const body = PhotoResultSchema.parse(await res.json());
    expect(body.status).toBe("passed");
    if (body.status !== "passed") return;
    expect(body.verdict).toMatchObject({ source: "stored", cue: "water" });
    expect(body.next?.stop.placeId).toBe("P3");
  });

  it("prefers the live reader when it answers", async () => {
    nextRead = { plausible: true, confidence: 0.9, observed: "gold letters on marble", cue: "writing" };
    const runId = await startDesk();
    const body = PhotoResultSchema.parse(await (await send(runId, "p1-water.jpg", "p1-water")).json());
    expect(body.status === "passed" && body.verdict).toMatchObject({ source: "live", cue: "writing" });
  });

  it("gives no stored result to another photo sent with a sample's id", async () => {
    const runId = await startDesk();
    const res = await send(runId, "", "p1-water", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]));
    expect(res.status).toBe(503); // the reader is down and there is no verdict: try again
  });
});

describe("the desk preview of a quest", () => {
  it("lists every place in walk order with its lines, links and cues, and every fact with its link", () => {
    const view = QuestViewSchema.parse(questView({ ...quest, id: DEMO_QUEST_ID }));
    expect(view.places[0]).toMatchObject({ id: "P1", role: "start", fork: true });
    expect(view.places.at(-1)).toMatchObject({ id: "P4", role: "answer" });
    expect(view.places[0].links.map((l) => l.cue).sort()).toEqual(["water", "writing"]);
    expect(view.facts.length).toBe(quest.facts.length);
    expect(view.editedByHand.length).toBeGreaterThan(0);
  });

  it("finds the text behind each line key and nothing else", () => {
    expect(lineText(quest, "briefing")).toBe(quest.briefing.text);
    expect(lineText(quest, "P2.clue")).toBe(placeById(quest, "P2")!.clue.text);
    expect(lineText(quest, "P1.to.P3")).toBe(placeById(quest, "P1")!.links.find((l) => l.to === "P3")!.reason);
    expect(lineText(quest, "P1.to.P4")).toBeNull();
    expect(lineText(quest, "P9.clue")).toBeNull();
    expect(lineText(quest, "constructor")).toBeNull();
  });

  it("GET /api/quests/[questId] serves the view; the line route answers text only with voice off", async () => {
    const view = await questRoute(new Request("http://localhost/api/quests/demo-karakoy"), { params: Promise.resolve({ questId: DEMO_QUEST_ID }) });
    expect(QuestViewSchema.parse(await view.json()).questId).toBe(DEMO_QUEST_ID);
    const line = (key: string) =>
      lineRoute(
        new Request("http://localhost/api/quests/demo-karakoy/line", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }),
        { params: Promise.resolve({ questId: DEMO_QUEST_ID }) },
      );
    const res = await line("P1.reveal");
    const body = QuestLineResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ voice: "off", line: { text: expect.stringContaining("1732") } });
    expect(body.line.clipId).toBeUndefined();
    expect((await line("P1.nope")).status).toBe(404);
  });
});

describe("the desk demo's committed voice (public/audio)", () => {
  const dir = join(process.cwd(), "public", "audio");
  const manifest = readStaticManifest(dir);

  it.skipIf(!manifest?.voiceId)("has a clip for every line of the demo quest and for the three sounds", () => {
    const { voiceId, modelId, clips } = manifest!;
    const ids = [
      ...questLines(quest).map((l) => clipIdFor(l.text, voiceId!, modelId!)),
      ...Object.values(SOUNDS).map((spec) => soundClipId(spec)),
    ];
    for (const id of ids) {
      expect(clips[id], id).toBeDefined();
      expect(existsSync(join(dir, `${id}.mp3`)), id).toBe(true);
    }
  });
});
