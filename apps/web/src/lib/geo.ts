export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * True when the player is close enough to an anchor to count as "there".
 * Phone GPS in a city is often 10–40 m off, so the reported accuracy widens the radius.
 */
export function isNear(
  player: LatLng & { accuracyM?: number },
  anchor: LatLng,
  radiusM = 60,
): boolean {
  const slack = Math.min(player.accuracyM ?? 0, 50);
  return distanceM(player, anchor) <= radiusM + slack;
}

/** Initial great-circle bearing from a to b, in degrees clockwise from north (0 ≤ b < 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export const COMPASS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Compass8 = (typeof COMPASS_8)[number];

/** Words for the on-screen hint ("120 m north-east"). Spoken lines use landmarks instead. */
export const COMPASS_NAMES: Record<Compass8, string> = {
  N: "north",
  NE: "north-east",
  E: "east",
  SE: "south-east",
  S: "south",
  SW: "south-west",
  W: "west",
  NW: "north-west",
};

/** The 8-point compass sector for a bearing (each sector is 45° wide, centred on its point). */
export function compass8(bearing: number): Compass8 {
  const normalised = ((bearing % 360) + 360) % 360;
  return COMPASS_8[Math.round(normalised / 45) % 8];
}

/** Compass direction from a to b, for the "too far" hint on screen. */
export function compassDirection(a: LatLng, b: LatLng): Compass8 {
  return compass8(bearingDeg(a, b));
}

/** Walking pace used to fit a route into its minutes. */
export const WALK_M_PER_MIN = 70;
/** Time spent at each stop: listen, look, photograph. */
export const MIN_PER_STOP = 2;

/** Minutes a walk of `distance` metres with `stops` stops takes (70 m/min plus ~2 min per stop). */
export function walkMinutes(distance: number, stops: number): number {
  return distance / WALK_M_PER_MIN + MIN_PER_STOP * stops;
}
