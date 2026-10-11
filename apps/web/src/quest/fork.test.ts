import { describe, expect, it, vi } from "vitest";
import { demoQuest } from "./demo";
import { decideByRules, ForkError, guardLink, linkForCue, nearestLink, pickNext, type MeaningPicker } from "./fork";
import { placeById } from "./routes";
import { OBSERVED_FALLBACK, type Quest } from "./schema";

// The desk demo quest: P1 is a fork (writing → P2, water → P3); P2 and P3 have one link (P4).
const quest: Quest = demoQuest();
const P1 = placeById(quest, "P1")!;
const seen = (observed: string, cue: "writing" | "water" | "material" | null = null) => ({ observed, cue });

describe("fork rule", () => {
  it("takes the link whose cue matches the reader's cue", async () => {
    const byMeaning = vi.fn<MeaningPicker>();
    const water = await pickNext(quest, "P1", seen("bronze spout over a stone basin", "water"), { byMeaning });
    expect(water).toMatchObject({ from: "P1", chosenBy: "cue", link: { to: "P3", cue: "water" } });
    expect(water.notTaken.map((l) => l.to)).toEqual(["P2"]);
    const writing = await pickNext(quest, "P1", seen("gilded inscription", "writing"), { byMeaning });
    expect(writing).toMatchObject({ chosenBy: "cue", link: { to: "P2" } });
    expect(byMeaning).not.toHaveBeenCalled();
  });

  it("goes to the only link of a stop with one link, whatever the cue", async () => {
    const d = await pickNext(quest, "P2", seen("iron gate", "material"));
    expect(d).toMatchObject({ chosenBy: "only-link", link: { to: "P4" }, notTaken: [] });
  });

  it("asks Gemma by meaning when no cue matches", async () => {
    const byMeaning = vi.fn<MeaningPicker>(async () => "P3");
    const d = await pickNext(quest, "P1", seen("a marble basin, dry", "material"), { byMeaning });
    expect(d).toMatchObject({ chosenBy: "meaning", link: { to: "P3" } });
    expect(byMeaning).toHaveBeenCalledWith(
      expect.objectContaining({ observed: "a marble basin, dry", names: { P2: expect.any(String), P3: "Hasan Ağa Fountain" } }),
    );
  });

  it("falls back to the nearest link when the meaning pick fails", async () => {
    const failures: string[] = [];
    const byMeaning = vi.fn<MeaningPicker>(async () => {
      throw new Error("timed out");
    });
    const d = await pickNext(quest, "P1", seen("a tiled panel", "material"), {
      byMeaning,
      onMeaningFailure: (r) => failures.push(r),
    });
    const expected = nearestLink(quest, P1)!;
    expect(d).toMatchObject({ chosenBy: "nearest", link: { to: expected.to } });
    expect(failures).toEqual(["timed out"]);
  });

  it("falls back to the nearest link when no detail was seen", async () => {
    const byMeaning = vi.fn<MeaningPicker>();
    const d = await pickNext(quest, "P1", null, { byMeaning });
    expect(d.chosenBy).toBe("nearest");
    expect(byMeaning).not.toHaveBeenCalled();
    // The people fallback names nothing to pick by meaning from.
    const vague = await pickNext(quest, "P1", seen(OBSERVED_FALLBACK), { byMeaning });
    expect(vague.chosenBy).toBe("nearest");
    expect(byMeaning).not.toHaveBeenCalled();
  });

  it("uses the player's position for the nearest fallback", async () => {
    const p2 = placeById(quest, "P2")!.location;
    const p3 = placeById(quest, "P3")!.location;
    expect((await pickNext(quest, "P1", null, { position: p2 })).link.to).toBe("P2");
    expect((await pickNext(quest, "P1", null, { position: p3 })).link.to).toBe("P3");
  });

  it("guards against a next stop that is not a link of the current place", async () => {
    const failures: string[] = [];
    const byMeaning = vi.fn<MeaningPicker>(async () => "P4"); // a real place, but not a link of P1
    const d = await pickNext(quest, "P1", seen("a tiled panel"), { byMeaning, onMeaningFailure: (r) => failures.push(r) });
    expect(d.chosenBy).toBe("nearest");
    expect(P1.links.map((l) => l.to)).toContain(d.link.to);
    expect(failures[0]).toMatch(/P4.*not a link of P1/);
    expect(guardLink(P1, "P9")).toBeNull();
    expect(guardLink(P1, null)).toBeNull();
    expect(guardLink(P1, "P2")?.to).toBe("P2");
  });

  it("refuses the answer place and unknown places", async () => {
    await expect(pickNext(quest, "P4", seen("stairs"))).rejects.toThrow(ForkError);
    await expect(pickNext(quest, "P9", seen("stairs"))).rejects.toThrow(/not a place/);
  });

  it("matches cues by code and leaves the rest to meaning or nearest", () => {
    expect(linkForCue(P1, "water")?.to).toBe("P3");
    expect(linkForCue(P1, "material")).toBeNull();
    expect(linkForCue(P1, null)).toBeNull();
    expect(decideByRules(P1, { cue: "material" })).toBeNull();
    expect(decideByRules(P1, null)).toBeNull();
  });
});
