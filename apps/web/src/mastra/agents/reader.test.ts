import { describe, expect, it } from "vitest";
import { solidPng } from "@/lib/solid-png";
import { scriptedModel, userText } from "@/test/mock-model";
import { demoQuest } from "@/quest/demo";
import { placeById } from "@/quest/routes";
import {
  gemmaMeaningPicker,
  matchCue,
  meaningPrompt,
  mentionsPeople,
  OBSERVED_FALLBACK,
  photoCheckTags,
  readerPrompt,
  readPhoto,
  toVerdict,
} from "./reader";

const OLLAMA = { GEMMA_PROVIDER: "ollama" };
const image = { data: solidPng(8, 8, [200, 180, 150]), mediaType: "image/png" };
const noSleep = async () => {};

describe("reader prompt", () => {
  it("offers the fork's cues, with what each covers, and asks for one", () => {
    const prompt = readerPrompt({ placeName: "Bereketzade Fountain", cues: ["writing", "water"] });
    expect(prompt).toContain("Bereketzade Fountain");
    expect(prompt).toMatch(/- writing: inscriptions/);
    expect(prompt).toMatch(/- water: a fountain/);
    expect(prompt).not.toMatch(/- material:/);
    expect(prompt).toMatch(/never people/);
    expect(prompt).toMatch(/screen/);
  });

  it("asks for no cue away from a fork", () => {
    expect(readerPrompt({ placeName: "Camondo Stairs" })).toContain('"cue": null.');
  });
});

describe("verdict clean-up", () => {
  const raw = { observed: "carved marble panel with a gilded inscription", cue: "writing", plausible: true, confidence: 0.86 };

  it("keeps a good answer", () => {
    expect(toVerdict(raw, ["writing", "water"])).toEqual({ ...raw, cue: "writing" });
  });

  it("drops a cue that was not offered and matches loose spellings", () => {
    expect(toVerdict({ ...raw, cue: "material" }, ["writing", "water"]).cue).toBeNull();
    expect(matchCue("Water", ["writing", "water"])).toBe("water");
    expect(matchCue("door/window/arch", ["door-window-arch"])).toBe("door-window-arch");
    expect(matchCue("none", ["water"])).toBeNull();
    expect(matchCue(null, ["water"])).toBeNull();
  });

  it("clamps or rescales confidence", () => {
    expect(toVerdict({ ...raw, confidence: 85 }, []).confidence).toBe(0.85);
    // Only whole numbers 2..100 are percentages: 1.2 is a slip on the 0..1 scale, clamped to 1.
    expect(toVerdict({ ...raw, confidence: 1.2 }, []).confidence).toBe(1);
    expect(toVerdict({ ...raw, confidence: 1 }, []).confidence).toBe(1);
    expect(toVerdict({ ...raw, confidence: 99.5 }, []).confidence).toBe(1);
    expect(toVerdict({ ...raw, confidence: -2 }, []).confidence).toBe(0);
    expect(toVerdict({ ...raw, confidence: 1000 }, []).confidence).toBe(1);
    expect(toVerdict({ ...raw, confidence: Number.NaN }, []).confidence).toBe(0);
  });

  it("cuts observed to 15 words and never describes people", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    expect(toVerdict({ ...raw, observed: long }, []).observed.split(" ")).toHaveLength(15);
    expect(toVerdict({ ...raw, observed: "a woman standing by a fountain" }, []).observed).toBe(OBSERVED_FALLBACK);
    expect(toVerdict({ ...raw, observed: "" }, []).observed).toBe(OBSERVED_FALLBACK);
    expect(mentionsPeople("tourists near the gate")).toBe(true);
    expect(mentionsPeople("a bronze tap")).toBe(false);
  });
});

describe("readPhoto", () => {
  it("sends the image and returns a clean verdict", async () => {
    const model = scriptedModel(['{"observed":"bronze spout over a stone basin","cue":"water","plausible":true,"confidence":0.9}']);
    const { verdict, meta } = await readPhoto(
      { image, placeName: "Bereketzade Fountain", cues: ["writing", "water"] },
      { env: OLLAMA, model, sleep: noSleep },
    );
    expect(verdict).toEqual({ observed: "bronze spout over a stone basin", cue: "water", plausible: true, confidence: 0.9 });
    expect(meta.role).toBe("reader");
    const call = model.doGenerateCalls[0];
    const user = call.prompt.find((m) => m.role === "user");
    expect((user?.content as Array<{ type: string }>).map((p) => p.type)).toEqual(["text", "file"]);
  });

  it("turns a cue outside the offered ones into null instead of a repair", async () => {
    const model = scriptedModel(['{"observed":"a carved crest","cue":"crest","plausible":true,"confidence":0.9}']);
    const { verdict, meta } = await readPhoto(
      { image, placeName: "X", cues: ["symbol-or-emblem", "water"] },
      { env: OLLAMA, model, sleep: noSleep },
    );
    expect(verdict.cue).toBeNull();
    expect(meta.repaired).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("sends the offered cues as an enum in the response schema", async () => {
    const model = scriptedModel(['{"observed":"a tap","cue":"water","plausible":true,"confidence":0.9}']);
    await readPhoto({ image, placeName: "X", cues: ["writing", "water"] }, { env: OLLAMA, model, sleep: noSleep });
    expect(JSON.stringify(model.doGenerateCalls[0].responseFormat)).toContain('"enum":["writing","water"]');
  });

  it("repairs once on a bad answer, then throws", async () => {
    const model = scriptedModel(["not json", "still not json"]);
    await expect(readPhoto({ image, placeName: "X" }, { env: OLLAMA, model, sleep: noSleep })).rejects.toThrow(/failed validation twice/);
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

describe("meaning picker", () => {
  const quest = demoQuest();
  const P1 = placeById(quest, "P1")!;
  const input = { place: P1, observed: "a dry marble basin", links: P1.links, names: { P2: "mosque", P3: "fountain" } };

  it("lists each link with its cue and reason", () => {
    const prompt = meaningPrompt(input);
    expect(prompt).toContain("a dry marble basin");
    for (const l of P1.links) expect(prompt).toContain(`- ${l.to}: detail "${l.cue}"`);
  });

  it("returns a place ID, or null for none or junk", async () => {
    expect(await gemmaMeaningPicker({ env: OLLAMA, model: scriptedModel(['{"to":"p3"}']) })(input)).toBe("P3");
    expect(await gemmaMeaningPicker({ env: OLLAMA, model: scriptedModel(['{"to":null}']) })(input)).toBeNull();
    expect(await gemmaMeaningPicker({ env: OLLAMA, model: scriptedModel(['{"to":"the mosque"}']) })(input)).toBeNull();
    const model = scriptedModel(['{"to":"P2"}']);
    await gemmaMeaningPicker({ env: OLLAMA, model })(input);
    expect(userText(model)).toContain("closest in meaning");
  });
});

describe("photoCheckTags", () => {
  it("tags the photo read with where it ran, for traces", () => {
    expect(photoCheckTags({ GEMMA_READER_PROVIDER: "ollama" }, { runId: "r1" })).toEqual({
      runId: "r1",
      role: "reader",
      provider: "ollama",
      model: "gemma4:e4b",
      checkedBy: "ollama/gemma4:e4b",
    });
    expect(photoCheckTags({ GEMMA_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: "test-key-not-real" }).checkedBy).toBe(
      "google/gemma-4-26b-a4b-it",
    );
  });
});
