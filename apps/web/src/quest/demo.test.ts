import { describe, expect, it } from "vitest";
import { distanceM } from "@/lib/geo";
import { DEMO_QUEST_ID, demoQuest, demoSource } from "./demo";
import { routesOf } from "./routes";
import { QuestSchema } from "./schema";
import { LIMITS, validateQuest } from "./validate";

describe("the Karaköy demo quest", () => {
  it("passes the validator", () => {
    const src = demoSource();
    const r = validateQuest(src.writer, src.facts, src.candidates, src.opts);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("is a saved demo quest with its hand edits listed", () => {
    const q = demoQuest();
    expect(QuestSchema.parse(q)).toEqual(q);
    expect(q.id).toBe(DEMO_QUEST_ID);
    expect(q.id).toBe("demo-karakoy");
    expect(q.demo).toBe(true);
    expect(q.status).toBe("ready");
    expect(q.editedByHand?.length).toBeGreaterThan(0);
    expect(q.model?.writer).toMatch(/^gemma/);
  });

  it("is a 15-minute, 3-stop quest with one writing-or-water fork", () => {
    const q = demoQuest();
    expect(q.minutes).toBe(15);
    expect(q.stopsPerRun).toBe(3);
    expect(q.places).toHaveLength(4);
    const start = q.places.find((p) => p.id === q.startPlaceId)!;
    expect(start.links.map((l) => l.cue).sort()).toEqual(["water", "writing"]);
    const routes = routesOf(q);
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route).toHaveLength(3);
      expect(route.at(-1)).toBe(q.answerPlaceId);
    }
  });

  it("keeps every hop within the limit", () => {
    const q = demoQuest();
    const at = new Map(q.places.map((p) => [p.id, p.location]));
    const start = at.get(q.startPlaceId)!;
    expect(distanceM(q.center, start)).toBeLessThanOrEqual(LIMITS.maxHopM);
    for (const p of q.places) {
      for (const l of p.links) {
        expect(distanceM(p.location, at.get(l.to)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
      }
    }
  });

  it("cites only fetched facts, each with a Wikipedia link", () => {
    const q = demoQuest();
    const ids = new Set(q.facts.map((f) => f.id));
    const cited = [
      ...q.mystery.factIds,
      ...q.finale.factIds,
      ...q.places.flatMap((p) => [...p.reveal.factIds, ...p.links.flatMap((l) => l.factIds)]),
    ];
    for (const id of cited) expect(ids.has(id)).toBe(true);
    for (const f of q.facts) {
      expect(f.source).toBe("wikipedia");
      expect(f.sourceUrl).toMatch(/^https:\/\/(en|tr)\.wikipedia\.org\/wiki\//);
    }
    const answerFacts = q.facts.filter((f) => f.placeId === q.answerPlaceId).map((f) => f.id);
    expect(q.mystery.factIds.some((id) => answerFacts.includes(id))).toBe(true);
  });

  it("returns a fresh copy each time", () => {
    const a = demoQuest();
    a.places[0].clue.text = "changed";
    expect(demoQuest().places[0].clue.text).not.toBe("changed");
  });
});
