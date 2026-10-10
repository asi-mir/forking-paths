import { describe, expect, it } from "vitest";
import { fourStop, type QuestFixture, threeStop } from "./__fixtures__";
import { BROKEN } from "./__fixtures__/broken";
import { compassWords, numbersIn, SAFETY_FIXES, safetyIssues, stopsForMinutes, validateQuest } from "./validate";

const run = (f: QuestFixture) => validateQuest(f.writer, f.facts, f.candidates, f.opts);

const errorsOf = (f: QuestFixture) => {
  const r = run(f);
  return r.ok ? [] : r.errors;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = (f: QuestFixture, id: string): any => f.writer.places.find((p: { id: string }) => p.id === id);

describe("validateQuest: the valid fixtures pass", () => {
  it("accepts the 3-stop quest and builds it from the candidates", () => {
    const r = run(threeStop());
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    const q = r.quest;
    expect(q.stopsPerRun).toBe(3);
    expect(q.status).toBe("ready");
    expect(q.places.map((p) => p.name)).toEqual([
      "Test Square Fountain",
      "Test Library",
      "Test Bathhouse",
      "Test Clock Tower",
    ]);
    expect(q.places[0].links.map((l) => l.cue)).toEqual(["writing", "water"]);
    expect(q.places[2].openNow).toBe(true);
    // Only cited facts are kept: F7 belongs to an unused candidate.
    expect(q.facts.map((f) => f.id)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    expect(q.validation).toEqual({ firstTryOk: true, firstTryErrors: [], repaired: false });
  });

  it("accepts the 4-stop quest with two forks", () => {
    const r = run(fourStop());
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(r.quest.stopsPerRun).toBe(4);
  });

  it("records a repaired draft in quest.validation", () => {
    const f = threeStop();
    f.opts.firstTryErrors = ["P2 reveal cites F99, which is not one of the facts."];
    const r = run(f);
    expect(r.ok && r.quest.validation).toEqual({
      firstTryOk: false,
      firstTryErrors: ["P2 reveal cites F99, which is not one of the facts."],
      repaired: true,
    });
  });

  it("picks 3 stops for 15 minutes and 4 for 25", () => {
    expect(stopsForMinutes(15)).toBe(3);
    expect(stopsForMinutes(25)).toBe(4);
  });
});

describe("validateQuest: one broken copy per rule fails with a specific error", () => {
  it.each(BROKEN.map((c) => [c.rule, c] as const))("%s", (_rule, c) => {
    const errors = errorsOf(c.make());
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => c.expect.test(e)), `got:\n${errors.join("\n")}`).toBe(true);
  });

  it("covers every rule group", () => {
    const groups = new Set(BROKEN.map((c) => c.rule.split(":")[0]));
    expect([...groups].sort()).toEqual(
      ["clues", "directions", "distance", "grounding", "numbers", "places", "research data", "routes", "safety", "writer output"].sort(),
    );
  });
});

describe("validateQuest: passing cases next to each rule", () => {
  it("numbers: numbers in words are not checked", () => {
    const f = threeStop();
    place(f, "P3").reveal.text = "From the eighteenth century on, this bathhouse drew water from the cistern.";
    expect(errorsOf(f)).toEqual([]);
  });

  it("numbers: 1500 matches a fact that says 1,500", () => {
    const f = threeStop();
    place(f, "P1").links[1].reason = "The cistern held 1500 cubic metres, and the bathhouse drank from it too.";
    expect(errorsOf(f)).toEqual([]);
  });

  it("numbers: an ordinal matches the same ordinal in a fact", () => {
    // P3's fixture reveal says "the 18th century", and F4 says "the 18th century".
    expect(place(threeStop(), "P3").reveal.text).toContain("18th");
    expect(errorsOf(threeStop())).toEqual([]);
  });

  it("routes: a three-way fork passes", () => {
    const f = threeStop();
    f.candidates.push({ id: "P6", name: "Test Garden", location: { lat: 41.0272, lng: 28.975 }, sourceUrl: "https://example.org/p6" });
    f.facts.push({ id: "F8", placeId: "P6", text: "The garden has a plane tree.", sourceUrl: "https://example.org/p6", sourceTitle: "Test Garden", query: "q", source: "wikipedia" });
    f.writer.places.push({ ...structuredClone(place(f, "P3")), id: "P6", reveal: { text: "The garden has a plane tree.", factIds: ["F8"] } });
    place(f, "P1").links.push({ to: "P6", cue: "plant-or-tree", reason: "The plane tree has a sibling in the garden.", factIds: ["F8"] });
    expect(errorsOf(f)).toEqual([]);
  });

  it("routes: a cue on the single link before the answer is dropped, not an error", () => {
    const f = threeStop();
    place(f, "P2").links[0].cue = "writing";
    const r = run(f);
    expect(r.ok && r.quest.places[1].links[0].cue).toBeUndefined();
  });

  it("numbers: a clue may use a number from its own place's facts", () => {
    const f = threeStop();
    place(f, "P1").clue = "Walk toward the square; the fountain from 1732 stands beside the café tables.";
    place(f, "P4").hint = "The bell from 1803 rings above the rooftops; walk toward it.";
    expect(errorsOf(f)).toEqual([]);
  });

  it("numbers: a clue may not borrow a number from another place's facts", () => {
    const f = threeStop();
    place(f, "P2").clue = "Head up the lane to the doorway that is older than 1803.";
    expect(errorsOf(f)).toEqual(["P2 clue says 1803, which is in none of P2's facts; leave it out or use a number from them."]);
  });

  it("numbers: a number in the place's name is allowed in its clue", () => {
    const f = threeStop();
    f.candidates.find((c) => c.id === "P2")!.name = "Test Library 7";
    place(f, "P2").clue = "Head up the lane toward Library 7 and its arched doorway.";
    expect(errorsOf(f)).toEqual([]);
  });

  it("directions: a clue may name a candidate whose name holds a compass word", () => {
    const f = threeStop();
    f.candidates.find((c) => c.id === "P4")!.name = "Northern Pier Clock Tower";
    place(f, "P4").clue = "Follow the Northern Pier Clock Tower toward the water.";
    expect(errorsOf(f)).toEqual([]);
  });

  it("research data: a fact without a placeId is fine", () => {
    const f = threeStop();
    delete f.facts.find((x) => x.id === "F7")!.placeId;
    expect(errorsOf(f)).toEqual([]);
  });

  it("safety: the fixture lines with 'climb the public steps', 'toward the water' pass", () => {
    expect(place(fourStop(), "P4").hint).toMatch(/Climb the public steps/);
    expect(errorsOf(fourStop())).toEqual([]);
  });
});

describe("numbersIn", () => {
  it("normalises digits, ordinals, separators and ranges", () => {
    expect(numbersIn("Built in 1732, the 18th of its kind, 1,500 m³, 1550–1557.")).toEqual([
      "1732",
      "18",
      "1500",
      "1550",
      "1557",
    ]);
    expect(numbersIn("No digits here, only three words")).toEqual([]);
  });

  it("splits numbers that share a separator and keeps decimals", () => {
    expect(numbersIn("1557,1558")).toEqual(["1557", "1558"]);
    expect(numbersIn("1.5 km, or 1,5 km")).toEqual(["1.5", "1.5"]);
    expect(numbersIn("15 m")).toEqual(["15"]);
    expect(numbersIn("1.500 people, the 1990s")).toEqual(["1500", "1990"]);
  });
});

describe("safetyIssues", () => {
  it.each([
    "Cross the street at the tram line.",
    "Step into the road to see the arch.",
    "Watch the traffic and go.",
    "Climb over the fence for a better view.",
    "Look into someone's garden.",
    "Go inside the shop.",
    "Enter the courtyard.",
    "Photograph the fishermen on the pier.",
    "Take a selfie by the fountain.",
    "Yolun karşısına geçin.",
    "Walk across the road to the fountain.",
    "Head over the road toward the water.",
    "Cross to the other side and find the arch.",
    "Stand on the other side of the street.",
    "Wait in the road for the tram to pass.",
    "Walk into the courtyard of the mosque.",
    "Dodge the traffic to reach the arch.",
    "Weave through traffic toward the tower.",
    "Photograph the boys fishing off the pier.",
    "Take a picture of the girl feeding pigeons.",
    "Snap the musician by the gate.",
    "Photograph the waiter at the café.",
    "Take a photo of him by the door.",
    "Photograph them by the fountain.",
    "Photograph the simit seller on the corner.",
  ])("blocks %j", (line) => {
    expect(safetyIssues(line)).not.toEqual([]);
  });

  it.each([
    "Photograph the statue of a woman above the door.",
    "Stay on the pavement and look for the entrance arch.",
    "His library is two streets on, toward the water.",
    "Photograph the one detail you think matters.",
    "Climb the public steps beside the library.",
    "Keep away from traffic and follow the quay.",
    "Turn left at the traffic lights.",
    "The plaque is set in the road surface.",
    "Two arches stand here; photograph one of them.",
  ])("allows %j", (line) => {
    expect(safetyIssues(line)).toEqual([]);
  });

  it.each(SAFETY_FIXES.map((fix) => [fix]))("its own fix text passes: %j", (fix) => {
    expect(safetyIssues(fix)).toEqual([]);
  });
});

describe("compassWords", () => {
  it("finds compass words in English and Turkish", () => {
    expect(compassWords("Head north, then south-east, then westward.")).toEqual(["north", "south-east", "westward"]);
    expect(compassWords("Kuzeye yürüyün.")).toEqual(["Kuzeye"]);
  });

  it("ignores words that only contain them", () => {
    expect(compassWords("Toward the water, past the Southampton sign; doğum günü.")).toEqual([]);
  });

  it("skips place names", () => {
    expect(compassWords("Follow the Northern Pier toward the water.")).toEqual([]);
    expect(compassWords("Walk to the West Gate, then north.")).toEqual(["north"]);
    expect(compassWords("Pass the northern pier sign.", ["Northern Pier"])).toEqual([]);
    expect(compassWords("Kuzey Kapı'ya yürüyün.")).toEqual([]);
  });
});
