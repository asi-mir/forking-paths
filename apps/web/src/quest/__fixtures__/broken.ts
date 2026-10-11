import { fourStop, type QuestFixture, threeStop } from "./index";

/**
 * One broken copy per validator rule. Each starts from a valid fixture, breaks exactly one
 * thing, and names the error the validator must return (a fragment of the message).
 */
export type BrokenCase = {
  rule: string;
  make: () => QuestFixture;
  expect: RegExp;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = (f: QuestFixture, id: string): any => f.writer.places.find((p: { id: string }) => p.id === id);

const broken = (base: () => QuestFixture, edit: (f: QuestFixture) => void) => () => {
  const f = base();
  edit(f);
  return f;
};

export const BROKEN: BrokenCase[] = [
  // --- Shape ---------------------------------------------------------------
  {
    rule: "writer output: a required field is missing",
    make: broken(threeStop, (f) => delete f.writer.finale),
    expect: /writer output at finale/,
  },
  {
    rule: "research data: a fact has no link",
    make: broken(threeStop, (f) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f.facts[0] as any).sourceUrl = "not a url";
    }),
    expect: /facts at 0\.sourceUrl/,
  },

  {
    rule: "research data: two facts share an ID",
    make: broken(threeStop, (f) => (f.facts[1].id = "F1")),
    expect: /research data: fact ID F1 is used twice/,
  },
  {
    rule: "research data: a fact points at a place that is not a candidate",
    make: broken(threeStop, (f) => (f.facts.find((x) => x.id === "F3")!.placeId = "P9")),
    expect: /research data: fact F3 has placeId P9, which is not a candidate\./,
  },

  // --- Grounding: unknown IDs ------------------------------------------------
  {
    rule: "grounding: a reveal cites an unknown fact",
    make: broken(threeStop, (f) => (place(f, "P2").reveal.factIds = ["F99"])),
    expect: /P2 reveal cites F99, which is not one of the facts/,
  },
  {
    rule: "grounding: a link reason cites an unknown fact",
    make: broken(threeStop, (f) => (place(f, "P1").links[0].factIds = ["F1", "F42"])),
    expect: /P1 → P2 link reason cites F42/,
  },
  {
    rule: "grounding: the mystery cites an unknown fact",
    make: broken(threeStop, (f) => f.writer.mystery.factIds.push("F77")),
    expect: /The mystery cites F77/,
  },
  {
    rule: "grounding: the finale cites an unknown fact",
    make: broken(fourStop, (f) => (f.writer.finale.factIds = ["F7", "F12"])),
    expect: /The finale cites F12/,
  },
  {
    rule: "grounding: a reveal cites no fact at all",
    make: broken(threeStop, (f) => (place(f, "P3").reveal.factIds = [])),
    expect: /P3 reveal cites no fact/,
  },

  // --- Grounding: numbers ----------------------------------------------------
  {
    rule: "numbers: a year in a reveal is not in its cited facts",
    make: broken(threeStop, (f) => (place(f, "P2").reveal.text = "The same patron founded this library in 1745.")),
    expect: /P2 reveal says 1745, which is not in its cited facts \(F3\)/,
  },
  {
    rule: "numbers: a number in a link reason is not in its cited facts",
    make: broken(fourStop, (f) => (place(f, "P2").links[1].reason = "The marble leads to an arcade of 14 arches.")),
    expect: /P2 → P5 link reason says 14/,
  },
  {
    rule: "numbers: a year in the mystery is not in its cited facts",
    make: broken(fourStop, (f) => (f.writer.mystery.answer = "The observatory on the hill, opened in 1762.")),
    expect: /The mystery says 1762/,
  },
  {
    rule: "numbers: a year in the finale is not in its cited facts",
    make: broken(threeStop, (f) => (f.writer.finale.text = "The bell you hear was cast in 1808.")),
    expect: /The finale says 1808/,
  },
  {
    rule: "numbers: an ordinal (19th) is not in the cited facts",
    make: broken(threeStop, (f) => (place(f, "P3").reveal.text = "From the 19th century on, this bathhouse drew its water from the cistern.")),
    expect: /P3 reveal says 19th, which is not in its cited facts \(F4\)/,
  },
  {
    rule: "numbers: a number in the briefing is in no fact",
    make: broken(threeStop, (f) => (f.writer.briefing = "In 1453 a patron left his mark here. Stay on the pavement.")),
    expect: /The briefing says 1453, which is in none of the facts/,
  },
  {
    rule: "numbers: a year in a clue is in none of the place's facts",
    make: broken(threeStop, (f) => (place(f, "P2").clue = "Find the fountain dated 1999 near the library steps.")),
    expect: /P2 clue says 1999, which is in none of P2's facts; leave it out or use a number from them/,
  },
  {
    rule: "numbers: a number in a hint is in none of the place's facts",
    make: broken(threeStop, (f) => (place(f, "P3").hint = "It is 120 steps past the 1888 sign.")),
    expect: /P3 hint says 120, which is in none of P3's facts/,
  },
  {
    rule: "numbers: a number in a look line is in none of the place's facts",
    make: broken(fourStop, (f) => (place(f, "P5").look = "Count the 14 arches, then photograph one.")),
    expect: /P5 look line says 14, which is in none of P5's facts/,
  },
  {
    rule: "grounding: a reveal cites no fact of its own place",
    make: broken(threeStop, (f) => (place(f, "P2").reveal = { text: "The verse on the fountain names this library's patron.", factIds: ["F1"] })),
    expect: /P2 reveal cites no fact of P2 \(its facts: F3\); cite at least one of them/,
  },
  {
    rule: "grounding: the mystery cites no fact of the answer place",
    make: broken(threeStop, (f) => {
      f.writer.mystery = { question: "Who paid for the fountain?", answer: "The patron named in its verse.", factIds: ["F1"] };
    }),
    expect: /The mystery cites no fact of the answer place P4 \(its facts: F5, F6\)/,
  },
  {
    rule: "grounding: an ID is written into a spoken line",
    make: broken(threeStop, (f) => (place(f, "P4").reveal.text = "As F5 says, the bell was cast in 1803.")),
    expect: /P4 reveal writes the ID F5 in its text/,
  },

  // --- Places and clues ------------------------------------------------------
  {
    rule: "places: a place is not in the candidate list",
    make: broken(threeStop, (f) => {
      place(f, "P3").id = "P9";
      place(f, "P1").links[1].to = "P9";
    }),
    expect: /P9 is not one of the candidate places/,
  },
  {
    rule: "places: a link goes to an unknown place",
    make: broken(threeStop, (f) => (place(f, "P2").links[0].to = "P8")),
    expect: /P2 links to P8, which is not one of the quest's places/,
  },
  {
    rule: "places: more than 6 places",
    make: broken(fourStop, (f) => {
      f.candidates.push({ id: "P7", name: "Test Seventh", location: { lat: 41.0275, lng: 28.975 }, sourceUrl: "https://example.org/p7" });
      f.facts.push({ id: "F9", placeId: "P7", text: "A seventh place.", sourceUrl: "https://example.org/p7", sourceTitle: "P7", query: "q", source: "wikipedia" });
      const p7 = structuredClone(place(f, "P5"));
      p7.id = "P7";
      f.writer.places.push(p7);
      place(f, "P1").links.push({ to: "P7", cue: "plant-or-tree", reason: "A seventh place.", factIds: ["F9"] });
    }),
    expect: /The quest uses 7 places; use at most 6/,
  },
  {
    rule: "places: a place is listed twice",
    make: broken(threeStop, (f) => f.writer.places.push(structuredClone(place(f, "P2")))),
    expect: /P2 is listed twice in places/,
  },
  {
    rule: "places: a place has no fact of its own",
    make: broken(threeStop, (f) => delete f.facts.find((x) => x.id === "F4")!.placeId),
    expect: /P3 \(Test Bathhouse\) has no fetched fact of its own/,
  },
  {
    rule: "places: a place is outside the quest radius",
    make: broken(threeStop, (f) => (f.opts.maxRadiusM = 200)),
    expect: /P4 \(Test Clock Tower\) is \d+ m from the quest centre; every place must be within 200 m/,
  },
  {
    rule: "clues: a clue has more than 30 words",
    make: broken(threeStop, (f) => {
      place(f, "P2").clue =
        "Head up the narrow lane past the bakery and the green shutters and the small blue bench toward the old arched doorway that has a carved stone book above it and a lamp.";
    }),
    expect: /P2 clue has 3\d words; keep it to 30 or fewer/,
  },
  {
    rule: "safety: a clue sends the player across a road",
    make: broken(threeStop, (f) => (place(f, "P2").clue = "Cross the road and head toward the arched doorway.")),
    expect: /P2 clue sends the player across a road \("Cross the road"\)/,
  },
  {
    rule: "safety: a clue mentions traffic",
    make: broken(threeStop, (f) => (place(f, "P3").hint = "Wait for a gap in the traffic, then look for the domes.")),
    expect: /P3 hint sends the player into traffic \("Wait for a gap in the traffic"\); lead the player along quiet pavements/,
  },
  {
    rule: "safety: a clue points at private property",
    make: broken(threeStop, (f) => (place(f, "P3").clue = "Slip through the private garden behind the domes.")),
    expect: /P3 clue points at private property/,
  },
  {
    rule: "safety: a clue tells the player to enter",
    make: broken(fourStop, (f) => (place(f, "P4").clue = "Enter the hall through the wide wooden door.")),
    expect: /P4 clue tells the player to enter/,
  },
  {
    rule: "safety: a look line asks for a photo of people",
    make: broken(fourStop, (f) => (place(f, "P5").look = "Photograph the fishermen on the steps.")),
    expect: /P5 look line asks the player to photograph people/,
  },
  {
    rule: "directions: a clue uses a compass word",
    make: broken(threeStop, (f) => (place(f, "P4").clue = "Walk north toward the clock face above the rooftops.")),
    expect: /P4 clue uses the compass word "north"; give a landmark direction instead/,
  },
  {
    rule: "directions: a bridge line (link reason) uses a compass word",
    make: broken(fourStop, (f) => (place(f, "P3").links[1].reason = "The arcade is south-east of here, carved by the same workshop.")),
    expect: /P3 → P5 link reason uses the compass word "south-east"/,
  },

  // --- Routes ----------------------------------------------------------------
  {
    rule: "routes: a route has the wrong number of stops",
    make: broken(threeStop, (f) => (place(f, "P1").links[0] = { to: "P4", cue: "writing", reason: "The verse leads straight to the tower.", factIds: ["F6"] })),
    expect: /Route P1 → P4 has 2 stops; a 3-stop quest needs exactly 3/,
  },
  {
    rule: "routes: a route does not end at the answer place",
    make: broken(threeStop, (f) => (place(f, "P3").links = [])),
    expect: /Route P1 → P3 ends at P3, not at the answer place P4/,
  },
  {
    rule: "routes: a fork has only one link",
    make: broken(fourStop, (f) => (place(f, "P2").links = place(f, "P2").links.slice(0, 1))),
    expect: /P2 is a fork \(stop 2 of 4\) but has 1 link\(s\)/,
  },
  {
    rule: "routes: a fork has more than three links",
    make: broken(fourStop, (f) => {
      place(f, "P1").links.push(
        { to: "P4", cue: "material", reason: "Tiles lead on.", factIds: ["F5"] },
        { to: "P5", cue: "plant-or-tree", reason: "Marble leads on.", factIds: ["F6"] },
      );
    }),
    expect: /P1 is a fork \(stop 1 of 4\) but has 4 link\(s\)/,
  },
  {
    rule: "routes: a fork links to the same place twice",
    make: broken(fourStop, (f) => (place(f, "P3").links[1].to = "P4")),
    expect: /P3 is a fork \(stop 2 of 4\) but two links go to P4/,
  },
  {
    rule: "routes: a fork repeats a cue",
    make: broken(threeStop, (f) => (place(f, "P1").links[0].cue = "water")),
    expect: /P1 is a fork \(stop 1 of 3\) but two links use the cue water/,
  },
  {
    rule: "routes: a fork uses a cue outside the cue list",
    make: broken(threeStop, (f) => (place(f, "P1").links[1].cue = "fountain")),
    expect: /P1 → P3 uses the cue "fountain", which is not in the cue list/,
  },
  {
    rule: "routes: a fork link has no cue",
    make: broken(fourStop, (f) => delete place(f, "P2").links[0].cue),
    expect: /P2 → P4 has no cue/,
  },
  {
    rule: "routes: the stop before the answer has two links",
    make: broken(fourStop, (f) => place(f, "P4").links.push({ to: "P5", reason: "The arcade is close.", factIds: ["F6"] })),
    expect: /P4 is the stop before the answer, so it needs exactly one link, to the answer place P6 \(it has 2: P6, P5\)/,
  },
  {
    rule: "routes: the answer place has links",
    make: broken(threeStop, (f) => place(f, "P4").links.push({ to: "P2", reason: "Back to the library.", factIds: ["F3"] })),
    expect: /The answer place P4 has 1 link\(s\); it must have none/,
  },
  {
    rule: "routes: a route visits a place twice",
    make: broken(fourStop, (f) => (place(f, "P5").links = [{ to: "P3", reason: "Back to the bathhouse.", factIds: ["F4"] }])),
    expect: /Route P1 → P3 → P5 → P3 visits P3 twice/,
  },
  {
    rule: "routes: a place is on no route",
    make: broken(threeStop, (f) => {
      f.writer.places.push({ ...structuredClone(place(f, "P2")), id: "P5", links: [] });
    }),
    expect: /P5 is on no route from the start P1/,
  },
  {
    rule: "routes: a link skips a stop",
    make: broken(fourStop, (f) => (place(f, "P1").links[1] = { to: "P4", cue: "water", reason: "The spring also ran to the hall.", factIds: ["F5"] })),
    expect: /Route P1 → P4 → P6 has 3 stops; a 4-stop quest needs exactly 4/,
  },

  // --- Distance --------------------------------------------------------------
  {
    rule: "distance: a stop → stop hop is longer than 250 m",
    make: broken(threeStop, (f) => (f.candidates.find((c) => c.id === "P3")!.location = { lat: 41.027, lng: 28.979 })),
    expect: /P1 → P3 is \d+ m; every hop must be 250 m or less/,
  },
  {
    rule: "distance: the start is more than 180 m from the centre",
    make: broken(threeStop, (f) => (f.opts.center = { lat: 41.0235, lng: 28.975 })),
    expect: /The start P1 is \d+ m from the quest centre; it must be within 180 m/,
  },
  {
    rule: "distance: the longest route does not fit the minutes",
    make: broken(threeStop, (f) => (f.opts = { ...f.opts, minutes: 10, stopsPerRun: 3 })),
    expect: /The longest route \(P1 → P\d → P4\) is \d+ m with 3 stops, about 12 min; a 10-min quest must fit in 10 min/,
  },
];
