import { distanceM, type LatLng } from "@/lib/geo";
import type { NextStop } from "./api";
import { placeById } from "./routes";
import { usableObserved, type Cue, type Link, type Place, type Quest, type Verdict } from "./schema";

/**
 * The fork rule: which link the player takes out of a place.
 *
 * 1. A place with one link goes to it ("only-link").
 * 2. At a fork, the link whose cue equals the reader's cue ("cue").
 * 3. Otherwise Gemma picks the closest link by meaning, given the detail it saw ("meaning").
 * 4. If that fails or gives no usable answer, the link to the nearest next place ("nearest").
 *
 * Guard: whatever is chosen must be a link of the current place. Pure code: the meaning pick is
 * passed in, so this module does no I/O.
 */

export type ChosenBy = NextStop["chosenBy"];

export type ForkDecision = {
  from: string; // the current place
  link: Link; // the link taken
  chosenBy: ChosenBy;
  notTaken: Link[]; // the other links of the place (the road not taken), in quest order
};

/** Asks Gemma which link fits the detail by meaning. Returns a place ID, or null for none. */
export type MeaningPicker = (input: {
  place: Place;
  observed: string;
  links: Link[];
  names: Record<string, string>;
}) => Promise<string | null>;

export class ForkError extends Error {
  override name = "ForkError";
}

/** The link of `place` that leads to `to`, or null: the guard against a made-up next stop. */
export function guardLink(place: Pick<Place, "links">, to: string | null | undefined): Link | null {
  if (!to) return null;
  return place.links.find((l) => l.to === to) ?? null;
}

/** The link whose cue equals the reader's cue (the first, if a quest ever repeats a cue). */
export function linkForCue(place: Pick<Place, "links">, cue: Cue | null | undefined): Link | null {
  if (!cue) return null;
  return place.links.find((l) => l.cue === cue) ?? null;
}

/**
 * The link to the next place nearest to `from` (default: the current place). Links to places
 * missing from the quest are ignored; ties keep quest order.
 */
export function nearestLink(quest: Pick<Quest, "places">, place: Place, from: LatLng = place.location): Link | null {
  let best: { link: Link; d: number } | null = null;
  for (const link of place.links) {
    const target = placeById(quest, link.to);
    if (!target) continue;
    const d = distanceM(from, target.location);
    if (!best || d < best.d) best = { link, d };
  }
  return best?.link ?? null;
}

const decision = (place: Place, link: Link, chosenBy: ChosenBy): ForkDecision => ({
  from: place.id,
  link,
  chosenBy,
  notTaken: place.links.filter((l) => l !== link),
});

/**
 * The rule's code part: only link, or cue match. Returns null when the meaning pick (or the
 * nearest fallback) has to decide. Throws when the place has no links (the answer place).
 */
export function decideByRules(place: Place, verdict: Pick<Verdict, "cue"> | null): ForkDecision | null {
  if (place.links.length === 0) throw new ForkError(`${place.id} has no links: it is the answer place`);
  if (place.links.length === 1) return decision(place, place.links[0], "only-link");
  const byCue = linkForCue(place, verdict?.cue);
  return byCue ? decision(place, byCue, "cue") : null;
}

export type PickNextOptions = {
  /** Gemma's pick by meaning. Without it (or without an observed detail), nearest decides. */
  byMeaning?: MeaningPicker;
  /** Where the player stands, for the nearest fallback (default: the current place). */
  position?: LatLng;
  /** Called when the meaning pick throws or names a place that is not a link here. */
  onMeaningFailure?: (reason: string) => void;
};

/**
 * Next stop out of `placeId`, by the fork rule. Never returns a link that is not one of the
 * current place's links.
 */
export async function pickNext(
  quest: Pick<Quest, "places">,
  placeId: string,
  verdict: Pick<Verdict, "cue" | "observed"> | null,
  options: PickNextOptions = {},
): Promise<ForkDecision> {
  const place = placeById(quest, placeId);
  if (!place) throw new ForkError(`${placeId} is not a place of this quest`);

  const byRules = decideByRules(place, verdict);
  if (byRules) return byRules;

  // The people fallback ("a detail of the place") names nothing to pick by: nearest decides.
  const observed = usableObserved(verdict?.observed);
  if (observed && options.byMeaning) {
    try {
      const names = Object.fromEntries(place.links.map((l) => [l.to, placeById(quest, l.to)?.name ?? l.to]));
      const to = await options.byMeaning({ place, observed, links: place.links, names });
      const link = guardLink(place, to);
      if (link) return decision(place, link, "meaning");
      if (to) options.onMeaningFailure?.(`picked ${to}, which is not a link of ${place.id}`);
    } catch (error) {
      options.onMeaningFailure?.((error as Error).message);
    }
  }

  const nearest = nearestLink(quest, place, options.position) ?? place.links[0];
  return decision(place, nearest, "nearest");
}
