import { describe, expect, it } from "vitest";
import { fourStop } from "./__fixtures__";
import {
  API,
  CaseFileSchema,
  type CitedFact,
  CreateQuestRequestSchema,
  parsePhotoForm,
  PHOTO_MAX_BYTES,
  sniffPhotoType,
  PhotoResultSchema,
  StartRunResponseSchema,
} from "./api";
import { roadNotTaken } from "./routes";
import { validateQuest } from "./validate";

const jpeg = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });

const form = (fields: Record<string, string | Blob>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

const stop = {
  placeId: "P2",
  stop: 2,
  of: 3,
  isFork: false,
  clue: { text: "Head up the lane.", clipId: "c2" },
  look: { text: "Look closely." },
} as const;

const fact: CitedFact = {
  id: "F1",
  text: "Built in 1732.",
  source: "wikipedia",
  sourceTitle: "Test Fountain",
  query: "geosearch 41.025,28.975",
  url: "https://example.org/wiki/Test_Fountain",
};

const verdict = { observed: "a carved verse", cue: "writing", plausible: true, confidence: 0.9, source: "live" } as const;

describe("API paths", () => {
  it("builds the run routes", () => {
    expect(API.photo("r1")).toBe("/api/runs/r1/photo");
    expect(API.finish("r 1")).toBe("/api/runs/r%201/finish");
  });
});

describe("POST /api/quests request", () => {
  it("defaults lang to en and accepts 15 or 25 minutes only", () => {
    expect(CreateQuestRequestSchema.parse({ lat: 41.02, lng: 28.97, minutes: 15 }).lang).toBe("en");
    expect(CreateQuestRequestSchema.safeParse({ lat: 41.02, lng: 28.97, minutes: 20 }).success).toBe(false);
  });
});

describe("POST /api/runs response", () => {
  it("parses a text-only start (voice off)", () => {
    const r = StartRunResponseSchema.safeParse({
      runId: "r1",
      questId: "q1",
      title: "The Patron's Bell",
      mystery: "What became of the pipes?",
      briefing: { text: "A patron left his mark." },
      first: { ...stop, placeId: "P1", stop: 1, isFork: true },
      preload: [],
      stingers: {},
      voice: false,
    });
    expect(r.success).toBe(true);
  });
});

describe("parsePhotoForm", () => {
  it("accepts a JPEG with GPS", () => {
    const r = parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat: "41.026", lng: "28.975", accuracy: "12" }));
    expect(r.ok && r.value.fields).toEqual({ placeId: "P1", lat: 41.026, lng: 28.975, accuracy: 12 });
  });

  it("accepts a photo without GPS (empty fields), with a desk demo sample ID", () => {
    const r = parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat: "", lng: "", sampleId: "p1-writing" }));
    expect(r.ok && r.value.fields).toEqual({ placeId: "P1", sampleId: "p1-writing" });
  });

  it("accepts PNG and WebP, the desk demo's sample formats", () => {
    expect(parsePhotoForm(form({ image: new Blob(["x"], { type: "image/png" }), placeId: "P1" })).ok).toBe(true);
    expect(parsePhotoForm(form({ image: new Blob(["x"], { type: "image/webp" }), placeId: "P1" })).ok).toBe(true);
  });

  it("rejects GPS fields that are not plain numbers", () => {
    for (const lat of ["abc", " ", "0x10", "Infinity", "41,02", "1e999"]) {
      expect(parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat, lng: "28.97" })).ok, lat).toBe(false);
    }
    expect(parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat: "41", lng: "28", accuracy: "-1" })).ok).toBe(false);
    expect(parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat: "91", lng: "28" })).ok).toBe(false);
  });

  it("rejects a photo over the size limit", () => {
    const big = new Blob([new Uint8Array(PHOTO_MAX_BYTES + 1)], { type: "image/jpeg" });
    expect(parsePhotoForm(form({ image: big, placeId: "P1" })).ok).toBe(false);
  });

  it("tells JPEG, PNG and WebP apart by their first bytes", () => {
    expect(sniffPhotoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffPhotoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffPhotoType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffPhotoType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffPhotoType(new TextEncoder().encode("<svg"))).toBeNull();
  });

  it("rejects half a GPS reading, a GIF, a missing photo and a bad place ID", () => {
    expect(parsePhotoForm(form({ image: jpeg(), placeId: "P1", lat: "41" })).ok).toBe(false);
    expect(parsePhotoForm(form({ image: new Blob(["x"], { type: "image/gif" }), placeId: "P1" })).ok).toBe(false);
    expect(parsePhotoForm(form({ placeId: "P1" })).ok).toBe(false);
    expect(parsePhotoForm(form({ image: jpeg(), placeId: "fountain" })).ok).toBe(false);
  });
});

describe("photo result", () => {
  const passed = {
    status: "passed",
    placeId: "P1",
    name: "Test Square Fountain",
    verdict,
    reveal: { line: { text: "Built in 1732." }, facts: [fact] },
    next: {
      bridge: { line: { text: "A verse: the library is up the lane." }, facts: [fact] },
      chosenBy: "cue",
      stop,
    },
    end: null,
  };

  it("parses passed, skipped, too-far and needs-retry results", () => {
    expect(PhotoResultSchema.safeParse(passed).success).toBe(true);
    expect(PhotoResultSchema.safeParse({ ...passed, status: "skipped", verdict: null }).success).toBe(true);
    expect(
      PhotoResultSchema.safeParse({
        status: "too-far",
        placeId: "P1",
        hint: { line: { text: "Look for the plane tree." }, distanceM: 140, direction: "NE" },
        retriesLeft: 1,
      }).success,
    ).toBe(true);
    expect(
      PhotoResultSchema.safeParse({
        status: "needs-retry",
        placeId: "P1",
        verdict: { ...verdict, plausible: false, confidence: 0.3, cue: null },
        message: { text: "That looks like a screen. Try a photo of the place itself." },
        retriesLeft: 2,
      }).success,
    ).toBe(true);
  });

  it("rejects a passed result with both a next stop and an end, or neither", () => {
    expect(PhotoResultSchema.safeParse({ ...passed, end: { finale: passed.reveal, caseFile: {} } }).success).toBe(false);
    expect(PhotoResultSchema.safeParse({ ...passed, next: null }).success).toBe(false);
  });

  it("builds a case file from a validated quest and roadNotTaken", () => {
    const f = fourStop();
    const r = validateQuest(f.writer, f.facts, f.candidates, f.opts);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    const q = r.quest;
    const path = ["P1", "P2", "P4", "P6"];
    const caseFile = {
      mystery: { question: q.mystery.question, answer: q.mystery.answer },
      route: path.map((id) => ({
        placeId: id,
        name: q.places.find((p) => p.id === id)!.name,
        status: "passed",
        observed: null,
        cue: null,
      })),
      notTaken: roadNotTaken(q, path),
      facts: q.facts.map((x) => ({ id: x.id, text: x.text, source: x.source, sourceTitle: x.sourceTitle, query: x.query, url: x.sourceUrl })),
    };
    expect(CaseFileSchema.safeParse(caseFile).success).toBe(true);
    expect(caseFile.notTaken).toHaveLength(2);
  });
});
