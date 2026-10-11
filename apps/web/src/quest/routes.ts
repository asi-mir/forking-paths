import type { Cue, ForkChoice, Place, Quest } from "./schema";

/** The least a route walk needs: place IDs and where their links go. Works on drafts too. */
export type RouteGraph = {
  startPlaceId: string;
  places: ReadonlyArray<{ id: string; links: ReadonlyArray<{ to: string }> }>;
};

/**
 * Every route from the start place, as lists of place IDs.
 *
 * A route ends at a place with no links, at a link to a place that does not exist (the
 * missing ID is kept as the last step), or when it comes back to a place it already visited
 * (the repeated ID is kept as the last step, so a validator can report it). Quests have at
 * most 6 places, so there are only a few routes.
 */
export function routesOf(quest: RouteGraph): string[][] {
  const byId = new Map(quest.places.map((p) => [p.id, p]));
  const routes: string[][] = [];

  const walk = (route: string[]) => {
    const id = route[route.length - 1];
    const place = byId.get(id);
    const revisit = route.indexOf(id) !== route.length - 1;
    if (!place || revisit || place.links.length === 0) {
      routes.push(route);
      return;
    }
    for (const link of place.links) walk([...route, link.to]);
  };

  walk([quest.startPlaceId]);
  return routes;
}

/** A fork is a place with more than one way out. */
export function isFork(place: Pick<Place, "links">): boolean {
  return place.links.length > 1;
}

export function placeById(quest: Pick<Quest, "places">, id: string): Place | undefined {
  return quest.places.find((p) => p.id === id);
}

/** A walked path: place IDs, or path steps of a run record. */
export type WalkedPath = ReadonlyArray<string> | ReadonlyArray<{ placeId: string; chosenBy?: ForkChoice["chosenBy"] }>;

const pathIds = (path: WalkedPath): string[] =>
  path.map((step) => (typeof step === "string" ? step : step.placeId));

/**
 * For each fork the player has left, the link they took and the ones they did not.
 * The case file uses it: "Had you photographed the water, you would have gone to the hamam."
 * A fork that is the last step of the path (not left yet) is not listed.
 */
export function roadNotTaken(quest: Pick<Quest, "places">, path: WalkedPath): ForkChoice[] {
  const ids = pathIds(path);
  const name = (id: string) => placeById(quest, id)?.name ?? id;
  const choices: ForkChoice[] = [];

  ids.forEach((id, i) => {
    const place = placeById(quest, id);
    const nextId = ids[i + 1];
    if (!place || !isFork(place) || nextId === undefined) return;
    const taken = place.links.find((l) => l.to === nextId);
    if (!taken) return;
    const step = path[i];
    const chosenBy = typeof step === "string" ? undefined : step.chosenBy;
    choices.push({
      at: place.id,
      atName: place.name,
      taken: { to: taken.to, name: name(taken.to), cue: cueOf(taken.cue) },
      ...(chosenBy ? { chosenBy } : {}),
      notTaken: place.links
        .filter((l) => l !== taken)
        .map((l) => ({
          to: l.to,
          name: name(l.to),
          cue: cueOf(l.cue),
          reason: l.reason,
          factIds: l.factIds,
        })),
    });
  });

  return choices;
}

const cueOf = (cue: Cue | undefined): Cue | null => cue ?? null;
