import { describe, expect, it } from "vitest";
import {
  acceptBridge,
  bridgeIssues,
  bridgeLine,
  bridgePrompt,
  detailOpening,
  namesDetail,
  sentenceCount,
  type BridgeContext,
} from "./bridge";
import { demoQuest } from "./demo";
import { placeById } from "./routes";
import { OBSERVED_FALLBACK } from "./schema";
import { numbersIn } from "./validate";

const quest = demoQuest();
const P1 = placeById(quest, "P1")!;
const toMosque = P1.links.find((l) => l.to === "P2")!; // writing; facts F2, F3, F8
const ctx: BridgeContext = { quest, place: P1, link: toMosque, observed: "carved marble panel with a gilded inscription" };

const good = {
  text: "That gilded inscription remembers an older fountain from the 15th century, built by a warden of the tower beside his mosque. Head downhill toward the water.",
  factIds: ["F3", "F8"],
};

describe("bridge line checks", () => {
  it("accepts a line that names the detail and cites the link's facts", () => {
    expect(bridgeIssues(good, ctx)).toEqual([]);
    expect(acceptBridge(good, ctx)).toEqual({ text: good.text, factIds: ["F3", "F8"], source: "narrator", rejected: [] });
  });

  it("rejects an unknown fact, or a fact of another link", () => {
    expect(bridgeIssues({ ...good, factIds: ["F99"] }, ctx).join()).toMatch(/F99, which is not one of the facts/);
    expect(bridgeIssues({ ...good, factIds: ["F3", "F10"] }, ctx).join()).toMatch(/F10, which is not a fact of this link/);
    expect(bridgeIssues({ ...good, factIds: [] }, ctx).join()).toMatch(/cites no fact/);
  });

  it("rejects a number that is not in the cited facts", () => {
    const issues = bridgeIssues({ ...good, text: "That gilded inscription is from 1732. Head downhill toward the water." }, ctx);
    expect(issues.join()).toMatch(/says 1732/);
  });

  it("rejects compass words, IDs in the text, and naming the next place", () => {
    expect(bridgeIssues({ ...good, text: "That gilded inscription points north, to a warden's mosque." }, ctx).join()).toMatch(/compass word "north"/);
    expect(bridgeIssues({ ...good, text: "That gilded inscription, as F3 says, leads on toward the water." }, ctx).join()).toMatch(/ID F3/);
    expect(bridgeIssues({ ...good, text: "That gilded inscription leads to the Bereketzade Ali Efendi Mosque." }, ctx).join()).toMatch(
      /names the next place/,
    );
  });

  it("rejects a line that does not name the detail, or runs too long", () => {
    expect(bridgeIssues({ ...good, text: "A warden of the tower built a mosque. Head downhill toward the water." }, ctx).join()).toMatch(
      /does not name the detail/,
    );
    const long = { ...good, text: "That gilded inscription is old. It is lovely. Walk on toward the water." };
    expect(bridgeIssues(long, ctx).join()).toMatch(/3 sentences/);
  });

  it("falls back to the link's stored reason, opened by the detail, on failure", () => {
    const opened = `You photographed the carved marble panel with a gilded inscription. ${toMosque.reason}`;
    const fallback = acceptBridge({ ...good, factIds: ["F99"] }, ctx);
    expect(fallback).toMatchObject({ text: opened, factIds: toMosque.factIds, source: "reason" });
    expect(fallback.rejected.length).toBeGreaterThan(0);
    expect(acceptBridge(null, ctx, "timed out")).toMatchObject({ text: opened, source: "reason", rejected: ["timed out"] });
  });

  it("a rejected line still gives a bridge that names the detail and passes the checks", () => {
    const rejected = acceptBridge({ ...good, text: "A warden of the tower built a mosque." }, ctx);
    expect(rejected.source).toBe("reason");
    expect(rejected.rejected.join()).toMatch(/does not name the detail/);
    expect(namesDetail(rejected.text, ctx.observed!)).toBe(true);
    expect(bridgeIssues({ text: rejected.text, factIds: rejected.factIds }, ctx).filter((i) => !/words|sentences/.test(i))).toEqual([]);
  });

  it("never states a number read off the photo, and names nothing for the people fallback", () => {
    const dated = { ...ctx, observed: "marble plaque dated 1732" };
    expect(detailOpening(dated)).toBe("You photographed the marble plaque.");
    const bridge = acceptBridge(null, dated, "timed out");
    expect(numbersIn(bridge.text).filter((n) => !numbersIn(toMosque.reason).includes(n))).toEqual([]);
    expect(acceptBridge(null, { ...ctx, observed: OBSERVED_FALLBACK }, "x").text).toBe(toMosque.reason);
    expect(acceptBridge(null, { ...ctx, observed: null }, "x").text).toBe(toMosque.reason);
    expect(acceptBridge(null, { ...ctx, quest: { ...quest, lang: "tr" } }, "x").text).toBe(toMosque.reason);
    expect(detailOpening({ ...ctx, observed: "a sign pointing north" })).toBeNull();
  });

  it("builds the cited line with each fact's link", () => {
    const line = bridgeLine(quest, acceptBridge(good, ctx));
    expect(line.line.text).toBe(good.text);
    expect(line.facts.map((f) => f.id)).toEqual(["F3", "F8"]);
    expect(line.facts.every((f) => f.url.startsWith("https://"))).toBe(true);
  });

  it("gives the narrator only the link's facts and the detail", () => {
    const prompt = bridgePrompt(ctx);
    expect(prompt).toContain(ctx.observed);
    for (const id of toMosque.factIds) expect(prompt).toContain(`- ${id}:`);
    expect(prompt).not.toContain("- F10:");
  });

  it("counts sentences and matches the detail by word stems", () => {
    expect(sentenceCount("One. Two!")).toBe(2);
    expect(sentenceCount("No end mark")).toBe(1);
    expect(namesDetail("Those inscriptions speak", "a carved inscription")).toBe(true);
    expect(namesDetail("A warden built it", "a carved inscription")).toBe(false);
    expect(namesDetail("anything", "an old")).toBe(true);
    // Generic words shared by most lines do not count as naming the detail.
    expect(namesDetail("The old stone wall is carved", "carved stone wall with a tughra")).toBe(false);
    expect(namesDetail("That tughra marks it", "carved stone wall with a tughra")).toBe(true);
  });
});
