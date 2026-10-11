import { describe, expect, it } from "vitest";
import { roadNotTakenLine } from "./labels";

describe("roadNotTakenLine", () => {
  it("names the cue without narrowing it", () => {
    expect(roadNotTakenLine("material", "Test Bathhouse")).toBe(
      "Had you photographed the material, you would have gone to Test Bathhouse.",
    );
    expect(roadNotTakenLine("date-or-number", "Test Library")).toContain("the date or number");
  });

  it("falls back to another detail when the link has no cue", () => {
    expect(roadNotTakenLine(null, "Test Library")).toBe("Had you photographed another detail, you would have gone to Test Library.");
  });

  it("does not claim the photo picked the way when the walk took the nearest one", () => {
    const line = roadNotTakenLine("water", "Test Bathhouse", "nearest");
    expect(line).not.toMatch(/Had you photographed/);
    expect(line).toContain("Test Bathhouse");
    expect(roadNotTakenLine("water", "Test Bathhouse", "cue")).toMatch(/^Had you photographed the water/);
  });
});
