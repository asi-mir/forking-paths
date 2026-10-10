import { describe, expect, it } from "vitest";
import { demoQuest } from "@/quest/demo";
import { bridgeItems, factCheckPrompt, questItems, revealCheckPrompt, shortHash, uniqueItems } from "./precheck";
import { cell, mdTable, percentile, ratio, sample, shuffled, stratifiedSample, tally } from "./stats";
import { decodeEntities, htmlToText, matchFact, numbersOf, withoutBrackets } from "./text-match";
import { errorKind, errorKinds } from "./validator-errors";
import { decideFact, decideReveal, readerSummary, validatorSummary, type FactEvidence, type ReaderOutcome } from "./verdicts";

describe("stats", () => {
  it("samples the same items for the same seed, in their original order", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = sample(items, 10, 7);
    expect(a).toEqual(sample(items, 10, 7));
    expect(a).toHaveLength(10);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect(sample(items, 10, 8)).not.toEqual(a);
    expect(sample(items, 99, 7)).toEqual(items);
  });

  it("shuffles without losing or adding items", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect([...shuffled(items, 3)].sort()).toEqual(items);
  });

  it("spreads a stratified sample over groups, small groups included", () => {
    const items = [...Array.from({ length: 30 }, (_, i) => ({ g: "reveal", i })), { g: "finale", i: 100 }, { g: "bridge", i: 101 }];
    const picked = stratifiedSample(items, (x) => x.g, 6, 1);
    expect(picked).toHaveLength(6);
    expect(picked.some((x) => x.g === "finale")).toBe(true);
    expect(picked.some((x) => x.g === "bridge")).toBe(true);
    expect(stratifiedSample(items, (x) => x.g, 100, 1)).toHaveLength(items.length);
  });

  it("handles repeated primitive values in a stratified sample", () => {
    expect(stratifiedSample(["x", "x", "x"], () => "g", 2, 1)).toEqual(["x", "x"]);
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
  });

  it("formats ratios, cells, tables and tallies", () => {
    expect(ratio(3, 4)).toBe("3/4 (75 %)");
    expect(ratio(0, 0)).toBe("0/0");
    expect(cell("a | b\nc")).toBe("a / b c");
    expect(cell(null)).toBe("-");
    expect(mdTable(["A", "B"], [[1, "x|y"]])).toBe("| A | B |\n|---|---|\n| 1 | x/y |");
    expect(tally(["b", "a", "b"])).toEqual([["b", 2], ["a", 1]]);
  });
});

describe("text matching", () => {
  it("turns HTML into text without scripts and with entities decoded", () => {
    const html = "<html><script>var x=1;</script><style>p{}</style><p>Built in 1732 &amp; restored.</p><p>It&#39;s &#x41;.</p></html>";
    expect(htmlToText(html)).toBe("Built in 1732 & restored.\nIt's A.");
    expect(decodeEntities("&nbsp;&hellip;&unknown;")).toBe(" …&unknown;");
  });

  it("finds a fact word for word, ignoring case, accents and punctuation", () => {
    const page = "Intro.\nThe Bereketzade Fountain was built in 1732. It stands near Galata Tower.";
    const m = matchFact("The bereketzade fountain was built in 1732.", page);
    expect(m.verbatim).toBe(true);
    expect(m.missingNumbers).toEqual([]);
  });

  it("finds a fact that quotes the page without its bracketed asides", () => {
    const page = "The Pantheon (Latin: Pantheum) is an ancient temple in Rome, built under Augustus (27 BC–AD 14).";
    expect(matchFact("The Pantheon is an ancient temple in Rome, built under Augustus.", page).verbatim).toBe(true);
    expect(withoutBrackets("a (b (c) d) e [f]")).toBe("a e");
  });

  it("accepts a fact whose sentences each appear on the page, apart", () => {
    const page = "Camondo built the stairs around 1870. Other text here. The stairs curve like a braid.";
    expect(matchFact("Camondo built the stairs around 1870. The stairs curve like a braid.", page).verbatim).toBe(true);
  });

  it("does not call a changed fact word for word, and names a missing number", () => {
    const page = "The fountain was built in 1732 by Mehmed Efendi. It has a long inscription.";
    const m = matchFact("The fountain was built in 1750 by Mehmed Efendi.", page);
    expect(m.verbatim).toBe(false);
    expect(m.missingNumbers).toEqual(["1750"]);
    expect(m.coverage).toBeGreaterThan(0.6);
    expect(m.passage).toContain("Mehmed Efendi");
  });

  it("does not call a fact word for word when a short sentence's number is not on the page", () => {
    const page = "The fountain was commissioned by Mahmud I in 1732. Rebuilt 1860.";
    const m = matchFact("The fountain was commissioned by Mahmud I in 1732. Rebuilt 1850.", page);
    expect(m.missingNumbers).toEqual(["1850"]);
    expect(m.verbatim).toBe(false);
  });

  it("checks a short piece with a number after a … cut, even when the number is elsewhere on the page", () => {
    const page = "The Genoese held the tower for a long time and rebuilt it in 1349. A fire hit it in 1348.";
    expect(matchFact("The Genoese held the tower for a long time … rebuilt 1348.", page).verbatim).toBe(false);
    expect(matchFact("The Genoese held the tower for a long time … A fire hit it in 1348.", page).verbatim).toBe(true);
  });

  it("still skips short pieces without a number", () => {
    const page = "The church was built by Dominican friars in the 13th century.";
    expect(matchFact("The church was built by Dominican friars in the 13th century. Truly.", page).verbatim).toBe(true);
  });

  it("lists digit groups once", () => {
    expect(numbersOf("In 1348-1349, the 15th century, 1348")).toEqual(["1348", "1349", "15"]);
  });
});

describe("validator error kinds", () => {
  it("groups the validator's messages", () => {
    expect(errorKind("P1 links to P3, which is not one of the quest's places (P1, P2, P7).")).toBe("link to a place left out of the quest");
    expect(errorKind("answerPlaceId P3 is not one of the quest's places.")).toBe("start or answer id wrong");
    expect(errorKind("The mystery cites no fact of the answer place P3 (its facts: F13); its answer must be a fact of that place.")).toBe(
      "mystery cites no fact of the answer place",
    );
    expect(errorKind("P1 → P5 link reason says 2, which is not in its cited facts (F30); use only numbers from those facts.")).toBe(
      "number not in the cited facts",
    );
    expect(errorKind("P1 → P5 link reason writes the ID P5 in its text; put IDs only in factIds.")).toBe("fact ID written in the text");
    expect(errorKind("writer output at places: Invalid input: expected array, received undefined")).toBe("answer was not JSON / schema");
    expect(errorKind("P2 clue has 34 words; keep it to 30 or fewer.")).toBe("clue over 30 words");
    expect(errorKind("P2 → P3 is 310 m; every hop must be 250 m or less.")).toBe("hop over 250 m");
    expect(errorKind("something new")).toBe("other");
  });

  it("names a safety message by its fix", () => {
    expect(errorKind("P1 clue tells the player to cross the road; keep the player on the pavement.")).toBe(
      "safety block list (road, private property, people)",
    );
  });

  it("counts each kind once per draft", () => {
    expect(errorKinds(["P1 links to P3, which is not one of the quest's places (P1).", "P2 links to P5, which is not one of the quest's places (P1)."])).toEqual([
      "link to a place left out of the quest",
    ]);
  });
});

describe("reveal check items", () => {
  const quest = demoQuest();

  it("lists every reveal, link reason, the mystery and the finale with their cited facts", () => {
    const items = questItems(quest);
    const links = quest.places.reduce((n, p) => n + p.links.length, 0);
    expect(items).toHaveLength(quest.places.length + links + 2);
    for (const i of items) {
      expect(i.facts.length).toBeGreaterThan(0);
      expect(i.unknownFactIds).toEqual([]);
      expect(i.key.startsWith(`${quest.id}:`)).toBe(true);
    }
    expect(items.filter((i) => i.kind === "finale")).toHaveLength(1);
  });

  it("takes bridge lines from a walked path and counts a repeated one once", () => {
    const fact = quest.facts[0];
    const step = { placeId: "P1", status: "passed" as const, observed: "a plaque", cue: null, bridge: "A line.", notTaken: [], to: "P2", bridgeFactIds: [fact.id] };
    const noBridge = { ...step, placeId: "P2", bridge: null, bridgeFactIds: undefined };
    const items = bridgeItems(quest, [step, noBridge]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "bridge", where: "P1 → P2", facts: [{ id: fact.id, text: fact.text }] });
    expect(uniqueItems([...items, ...bridgeItems(quest, [step])])).toHaveLength(1);
  });

  it("marks cited IDs the quest does not have", () => {
    const items = bridgeItems(quest, [{ placeId: "P1", status: "passed", observed: null, cue: null, bridge: "A line.", notTaken: [], to: "P2", bridgeFactIds: ["F999"] }]);
    expect(items[0].unknownFactIds).toEqual(["F999"]);
  });

  it("puts the line and its facts into the pre-check prompts", () => {
    const p = revealCheckPrompt({ kind: "reveal", text: "Built in 1732.", facts: [{ id: "F1", text: "It was built in 1732." }] });
    expect(p).toContain('"Built in 1732."');
    expect(p).toContain("F1: It was built in 1732.");
    expect(factCheckPrompt("A fact.", "A passage.")).toContain('"""A passage."""');
  });

  it("hashes text stably", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
    expect(shortHash("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("verdicts and summaries", () => {
  const fact = (over: Partial<FactEvidence>): FactEvidence => ({ fetch: { ok: true }, match: { verbatim: false }, gemma: null, review: null, ...over });

  it.each<[string, FactEvidence, string, string]>([
    ["owner review wins over everything", fact({ match: { verbatim: true }, gemma: { verdict: "holds" }, review: { verdict: "missed", by: "owner" } }), "missed", "owner"],
    ["agent review wins over code and Gemma", fact({ match: { verbatim: true }, gemma: { verdict: "holds" }, review: { verdict: "partly", by: "agent" } }), "partly", "agent"],
    ["a review counts even when the page could not be read", fact({ fetch: { ok: false }, match: null, review: { verdict: "held", by: "owner" } }), "held", "owner"],
    ["no page, no review: not checkable", fact({ fetch: { ok: false }, match: null, gemma: { verdict: "holds" } }), "not checkable", "-"],
    ["word for word: held by code", fact({ match: { verbatim: true }, gemma: { verdict: "not-found" } }), "held", "code (word for word)"],
    ["Gemma holds", fact({ gemma: { verdict: "holds" } }), "held", "gemma pre-check"],
    ["Gemma partly", fact({ gemma: { verdict: "partly" } }), "partly", "gemma pre-check"],
    ["Gemma not found: missed", fact({ gemma: { verdict: "not-found" } }), "missed", "gemma pre-check"],
    ["page read, Gemma failed, no review: not checked", fact({ gemma: { error: "timeout" } }), "not checked", "-"],
    ["page read, no pre-check, no review: not checked", fact({}), "not checked", "-"],
  ])("fact: %s", (_, evidence, verdict, decidedBy) => {
    expect(decideFact(evidence)).toEqual({ verdict, decidedBy });
  });

  it("reveal: a review overrides Gemma, Gemma counts alone, an error is not checked", () => {
    expect(decideReveal({ verdict: "unsupported", by: "owner" }, { verdict: "supported" })).toEqual({ verdict: "unsupported", decidedBy: "owner" });
    expect(decideReveal({ verdict: "partly", by: "agent" }, null)).toEqual({ verdict: "partly", decidedBy: "agent" });
    expect(decideReveal(null, { verdict: "supported" })).toEqual({ verdict: "supported", decidedBy: "gemma pre-check" });
    expect(decideReveal(null, { error: "timeout" })).toEqual({ verdict: "not checked", decidedBy: "-" });
    expect(decideReveal(null, null)).toEqual({ verdict: "not checked", decidedBy: "-" });
  });

  it("validator: exclusive buckets that add up to the drafted count, odd cases named", () => {
    const s = validatorSummary([
      { id: "a", status: "ready", validation: { firstTryOk: true, repaired: false } },
      { id: "b", status: "ready", validation: { firstTryOk: false, repaired: true } },
      { id: "c", status: "failed", validation: { firstTryOk: false, repaired: true } },
      { id: "d", status: "failed", validation: { firstTryOk: false, repaired: false } },
      { id: "e", status: "failed", validation: { firstTryOk: true, repaired: false } },
      { id: "f", status: "ready", validation: { firstTryOk: false, repaired: false } },
      { id: "g", status: "no-draft" },
    ]);
    expect(s).toEqual({ generations: 7, drafted: 6, firstTry: 2, afterRepair: 1, failed: 3, noDraft: 1, mismatch: ["e", "f"] });
    expect(s.firstTry + s.afterRepair + s.failed).toBe(s.drafted);
  });

  it("reader: counts cue accuracy on street details only and latency on calls that answered", () => {
    const row = (over: Partial<ReaderOutcome>): ReaderOutcome => ({
      offered: ["a", "b"],
      expected: { plausible: true, cue: "a" },
      error: null,
      latencyMs: 100,
      plausibleOk: true,
      cueOk: true,
      passOk: true,
      ...over,
    });
    const s = readerSummary([
      row({}),
      row({ cueOk: false, latencyMs: 300 }),
      row({ expected: { plausible: true, cue: null }, offered: ["a", "b", "c"] }),
      row({ expected: { plausible: false, cue: null }, cueOk: false, passOk: true, latencyMs: 200 }),
      row({ error: "timeout", plausibleOk: false, cueOk: false, passOk: false, latencyMs: 9999 }),
    ]);
    expect(s).toMatchObject({ photos: 5, errors: 1, positives: 4, cueOk: 2, cueOffered: 3, cueOfferedOk: 1, cueNone: 1, cueNoneOk: 1, negatives: 1, negativesRefused: 1, passOk: 4, p50Ms: 100, p95Ms: 300 });
    expect(s.chance).toBeCloseTo(1.5);
  });
});
