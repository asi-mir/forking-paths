import { ObjectId } from "mongodb";
import { QuestSchema, type Quest } from "@/quest/schema";
import { roundCenter, type LatLng } from "../geo";

/** A new id: 24 hex characters, time-ordered (a MongoDB ObjectId as a string). */
export function newId(): string {
  return new ObjectId().toHexString();
}

/**
 * Problems that make a quest unsafe to store as ready: a cited fact the quest does not carry,
 * or a link to a place it does not have. The validator catches these first; this is the
 * last check before the quest can reach a player.
 */
export function citationErrors(quest: Quest): string[] {
  const facts = new Set(quest.facts.map((f) => f.id));
  const places = new Set(quest.places.map((p) => p.id));
  const errors: string[] = [];
  const cite = (where: string, ids: string[]) => {
    for (const id of ids) if (!facts.has(id)) errors.push(`${where} cites ${id}, which the quest does not carry`);
  };
  cite("the mystery", quest.mystery.factIds);
  cite("the finale", quest.finale.factIds);
  for (const p of quest.places) {
    cite(`${p.id}'s reveal`, p.reveal.factIds);
    for (const l of p.links) {
      cite(`the link ${p.id} → ${l.to}`, l.factIds);
      if (!places.has(l.to)) errors.push(`the link ${p.id} → ${l.to} goes to a place the quest does not have`);
    }
  }
  for (const id of [quest.startPlaceId, quest.answerPlaceId]) {
    if (!places.has(id)) errors.push(`${id} is not one of the quest's places`);
  }
  return errors;
}

/** Parses and normalises a quest before it is stored: id, creation time, centre rounded to ~100 m. */
export function prepareQuest(input: Quest, now = new Date()): Quest & { id: string; createdAt: string } {
  const quest = QuestSchema.parse(input);
  if (quest.status === "ready") {
    const errors = citationErrors(quest);
    if (errors.length) throw new Error(`Refusing to save quest: ${errors.join("; ")}.`);
  }
  return {
    ...quest,
    id: quest.id ?? newId(),
    createdAt: quest.createdAt ?? now.toISOString(),
    center: roundCenter(quest.center),
  };
}

/** The cache key for a lookup near a point: "<source>:<rounded lat,lng>:<query>". */
export function cacheKey(source: string, at: LatLng, query: string): string {
  const c = roundCenter(at);
  return `${source}:${c.lat},${c.lng}:${query.trim().toLowerCase()}`;
}

/** Checks a budget amount: a positive finite number. */
export function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError(`budget amount must be positive, got ${amount}`);
}
