import { COMPASS_NAMES, compassDirection, distanceM, type Compass8, type LatLng } from "@/lib/geo";
import type { Hint } from "./api";
import type { Place, Verdict } from "./schema";

/**
 * The photo check's rules, as pure functions: presence (GPS), the pass rule and the "too far"
 * hint. No model call and no I/O here; `photo-check.ts` wires them to the reader.
 *
 * - GPS proves presence, and presence alone passes the stop: the reader never blocks a player
 *   whom GPS puts at the place.
 * - With GPS missing (location denied, or the desk demo), the photo has to look plausible.
 * - GPS that puts the player too far away fails the stop without a model call.
 */

/** Base radius around a place, in metres. */
export const PRESENCE_RADIUS_M = 60;
/** The phone's reported accuracy widens the radius by at most this much. */
export const MAX_ACCURACY_SLACK_M = 50;
/** With GPS missing, the photo passes when the reader is at least this sure it was taken here. */
export const PASS_CONFIDENCE = 0.7;

/** One GPS reading from the phone. `accuracyM` is the browser's reported accuracy, in metres. */
export type Position = LatLng & { accuracyM?: number };

/** What GPS says about the player and the place. */
export type Presence =
  | { gps: false }
  | {
      gps: true;
      near: boolean;
      /** Straight-line distance to the place, in metres. */
      distanceM: number;
      accuracyM: number | null;
      /** The radius used: base radius plus the capped accuracy slack. */
      radiusM: number;
      /** Compass direction from the player to the place (shown on screen when too far). */
      direction: Compass8;
    };

/** True when the reading is a usable position (finite numbers in range). */
export function hasFix(position: Partial<Position> | null | undefined): position is Position {
  if (!position) return false;
  const { lat, lng } = position;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Presence: `near` = distance to the place ≤ 60 m + min(accuracy, 50 m). A missing or broken
 * reading gives `{ gps: false }`.
 */
export function presence(place: Pick<Place, "location">, position: Partial<Position> | null | undefined): Presence {
  if (!hasFix(position)) return { gps: false };
  const accuracy =
    typeof position.accuracyM === "number" && Number.isFinite(position.accuracyM) && position.accuracyM >= 0
      ? position.accuracyM
      : null;
  const radiusM = PRESENCE_RADIUS_M + Math.min(accuracy ?? 0, MAX_ACCURACY_SLACK_M);
  const d = distanceM(position, place.location);
  return {
    gps: true,
    near: d <= radiusM,
    distanceM: d,
    accuracyM: accuracy,
    radiusM,
    direction: compassDirection(position, place.location),
  };
}

/** The reader runs unless GPS already says the player is too far (then no model call). */
export function shouldRead(p: Presence): boolean {
  return !p.gps || p.near;
}

/** Why a photo passed or failed. */
export type PassReason =
  | "near" // GPS puts the player at the place: passes, whatever the reader says
  | "too-far" // GPS puts the player away from the place
  | "plausible" // no GPS; the reader says the photo was plausibly taken here, confidently enough
  | "implausible" // no GPS; the reader says it was not (a screen, a room at home)
  | "low-confidence" // no GPS; plausible, but below PASS_CONFIDENCE
  | "no-verdict"; // no GPS and no reader result (the reader failed and no stored result exists)

export type PassDecision = { passed: boolean; by: "gps" | "photo" | null; reason: PassReason };

/**
 * The pass rule. `near` passes, whatever the reader says. GPS that puts the player away fails.
 * With GPS missing: pass when `plausible && confidence ≥ 0.7`.
 */
export function passRule(p: Presence, verdict: Verdict | null): PassDecision {
  if (p.gps) {
    return p.near ? { passed: true, by: "gps", reason: "near" } : { passed: false, by: "gps", reason: "too-far" };
  }
  if (!verdict) return { passed: false, by: null, reason: "no-verdict" };
  if (!verdict.plausible) return { passed: false, by: "photo", reason: "implausible" };
  if (verdict.confidence < PASS_CONFIDENCE) return { passed: false, by: "photo", reason: "low-confidence" };
  return { passed: true, by: "photo", reason: "plausible" };
}

/**
 * Distance for the screen: metres rounded to 10 (5 below 100 m), kilometres with one decimal
 * from 1 km on. "120 m", "1.4 km".
 */
export function formatDistance(metres: number): string {
  const m = Math.max(0, metres);
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toFixed(1)} km`;
  const step = m < 100 ? 5 : 10;
  return `${Math.max(step, Math.round(m / step) * step)} m`;
}

/** The on-screen hint label: "about 120 m north-east". Spoken lines use landmarks instead. */
export function hintLabel(distance: number, direction: Compass8): string {
  return `about ${formatDistance(distance)} ${COMPASS_NAMES[direction]}`;
}

/**
 * The "too far" hint: the place's spoken hint, plus distance and compass direction for the
 * screen. Null when GPS is missing or the player is near (there is nothing to hint).
 */
export function hintFor(place: Pick<Place, "hint">, p: Presence): Hint | null {
  if (!p.gps || p.near) return null;
  return {
    line: { text: place.hint.text },
    distanceM: Math.round(p.distanceM),
    direction: p.direction,
  };
}

/** What to say when GPS is missing and the photo did not pass: try another, closer photo. */
export function retryMessage(reason: PassReason): string {
  switch (reason) {
    case "implausible":
      return "That doesn't look like it was taken here. Photograph the detail itself, outdoors at the place.";
    case "low-confidence":
      return "I can't quite tell. Get closer and photograph the one detail you chose.";
    case "no-verdict":
      return "I couldn't read that photo. Try again, a little closer.";
    default:
      return "Try another photo of the detail.";
  }
}
