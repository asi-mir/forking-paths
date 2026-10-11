import { describe, expect, it } from "vitest";
import { cacheKey, citationErrors, prepareQuest } from "./shared";
import { validQuest } from "./store.contract";

describe("citationErrors", () => {
  it("passes a valid quest", () => {
    expect(citationErrors(validQuest())).toEqual([]);
  });

  it("names unknown facts and places", () => {
    const q = validQuest();
    q.finale.factIds = ["F42"];
    q.places[0].links[0].to = "P9";
    q.answerPlaceId = "P8";
    const errors = citationErrors(q);
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/finale cites F42/);
    expect(errors.join("\n")).toMatch(/P9/);
    expect(errors.join("\n")).toMatch(/P8/);
  });
});

describe("prepareQuest", () => {
  it("lets a failed quest with bad citations be stored (kept for evals)", () => {
    const q = validQuest({ status: "failed" });
    q.mystery.factIds = ["F77"];
    expect(prepareQuest(q).status).toBe("failed");
  });

  it("rejects a quest that does not match the schema", () => {
    expect(() => prepareQuest({ ...validQuest(), places: [] })).toThrow();
  });
});

describe("cacheKey", () => {
  it("rounds the point and normalises the query", () => {
    expect(cacheKey("serpapi-maps", { lat: 41.02549, lng: 28.97512 }, "  Historical Landmark ")).toBe(
      "serpapi-maps:41.025,28.975:historical landmark",
    );
    expect(cacheKey("wikipedia", { lat: -0.0001, lng: 0.0004 }, "geosearch")).toBe("wikipedia:0,0:geosearch");
  });
});
