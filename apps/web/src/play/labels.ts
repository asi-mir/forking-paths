import { COMPASS_NAMES, type Compass8 } from "@/lib/geo";
import type { Cue, FactSource } from "@/quest/schema";

/** Plain source labels for fact cards: where the fact came from, nothing more. */
export const SOURCE_LABEL: Record<FactSource, string> = {
  wikipedia: "Wikipedia",
  "serpapi-maps": "Google Maps via SerpApi",
  "serpapi-search": "Google Search via SerpApi",
};

/** How a cue reads in a sentence: "Had you photographed the water, …". */
export const CUE_PHRASE: Record<Cue, string> = {
  writing: "the writing",
  "date-or-number": "the date or number",
  water: "the water",
  "animal-or-figure": "the carved figure",
  "plant-or-tree": "the tree",
  "symbol-or-emblem": "the emblem",
  "door-window-arch": "the doorway",
  material: "the material",
};

/** A short tag for a cue chip. */
export const CUE_TAG: Record<Cue, string> = {
  writing: "writing",
  "date-or-number": "date or number",
  water: "water",
  "animal-or-figure": "animal or figure",
  "plant-or-tree": "plant or tree",
  "symbol-or-emblem": "symbol or emblem",
  "door-window-arch": "door, window or arch",
  material: "material",
};

/** "Had you photographed the water, you would have gone to Test Bathhouse." */
export function roadNotTakenLine(cue: Cue | null, placeName: string): string {
  const what = cue ? CUE_PHRASE[cue] : "another detail";
  return `Had you photographed ${what}, you would have gone to ${placeName}.`;
}

/** "140 m" (rounded to 10 m) or "1.2 km". */
export function distanceText(distanceM: number): string {
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(distanceM / 10) * 10)} m`;
}

/** "140 m north-east" for the too-far hint on screen. */
export function distanceLine(distanceM: number, direction: Compass8): string {
  return `${distanceText(distanceM)} ${COMPASS_NAMES[direction]}`;
}

/** Degrees for a compass point, for the arrow on the too-far screen. */
export const COMPASS_DEG: Record<Compass8, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

/** The host of a link, for a compact label ("en.wikipedia.org"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
