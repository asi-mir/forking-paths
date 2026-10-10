import { describe, expect, it } from "vitest";
import { fourStop, threeStop } from "./__fixtures__";
import { isFork, roadNotTaken, routesOf } from "./routes";
import { validateQuest } from "./validate";

const questOf = (f: ReturnType<typeof threeStop>) => {
  const r = validateQuest(f.writer, f.facts, f.candidates, f.opts);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.quest;
};

describe("routesOf", () => {
  it("lists both routes of the 3-stop quest", () => {
    expect(routesOf(questOf(threeStop()))).toEqual([
      ["P1", "P2", "P4"],
      ["P1", "P3", "P4"],
    ]);
  });

  it("lists the four routes of the 4-stop quest, all ending at the answer", () => {
    const routes = routesOf(questOf(fourStop()));
    expect(routes).toEqual([
      ["P1", "P2", "P4", "P6"],
      ["P1", "P2", "P5", "P6"],
      ["P1", "P3", "P4", "P6"],
      ["P1", "P3", "P5", "P6"],
    ]);
  });

  it("stops at a revisit or a missing place and keeps that ID last", () => {
    const graph = {
      startPlaceId: "P1",
      places: [
        { id: "P1", links: [{ to: "P2" }, { to: "P9" }] },
        { id: "P2", links: [{ to: "P1" }] },
      ],
    };
    expect(routesOf(graph)).toEqual([
      ["P1", "P2", "P1"],
      ["P1", "P9"],
    ]);
  });
});

describe("roadNotTaken", () => {
  it("lists the road not taken at the fork, with place, cue and reason", () => {
    const quest = questOf(threeStop());
    expect(roadNotTaken(quest, ["P1", "P2", "P4"])).toEqual([
      {
        at: "P1",
        atName: "Test Square Fountain",
        taken: { to: "P2", name: "Test Library", cue: "writing" },
        notTaken: [
          {
            to: "P3",
            name: "Test Bathhouse",
            cue: "water",
            reason: "That water came from a cistern of 1,500 cubic metres, and the bathhouse up the hill drank from it too.",
            factIds: ["F2", "F4"],
          },
        ],
      },
    ]);
  });

  it("covers both forks of a 4-stop walk and accepts run path steps", () => {
    const quest = questOf(fourStop());
    const path = ["P1", "P3", "P5", "P6"].map((placeId) => ({ placeId }));
    const choices = roadNotTaken(quest, path);
    expect(choices.map((c) => [c.at, c.taken.to, c.notTaken.map((n) => `${n.to}:${n.cue}`)])).toEqual([
      ["P1", "P3", ["P2:writing"]],
      ["P3", "P5", ["P4:animal-or-figure"]],
    ]);
  });

  it("skips a fork the player has not left yet", () => {
    expect(roadNotTaken(questOf(threeStop()), ["P1"])).toEqual([]);
  });

  it("knows which places are forks", () => {
    const quest = questOf(threeStop());
    expect(quest.places.map(isFork)).toEqual([true, false, false, false]);
  });
});
