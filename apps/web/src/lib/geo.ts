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
