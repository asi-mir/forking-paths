/**
 * The points of the SerpApi coverage eval (`scripts/eval-coverage.ts`): per city a centre (the
 * old town), a residential district and a point near the city's edge. The kinds are a rough label
 * picked from a map, not a measured category. The centres also seed the validator eval's
 * `--generate` runs.
 */
export type CoveragePoint = {
  city: string;
  kind: "centre" | "residential" | "edge";
  area: string;
  lat: number;
  lng: number;
  timeZone: string;
};

export const COVERAGE_POINTS: readonly CoveragePoint[] = [
  { city: "Istanbul", kind: "centre", area: "Karaköy", lat: 41.0247, lng: 28.9744, timeZone: "Europe/Istanbul" },
  { city: "Istanbul", kind: "residential", area: "Bahçelievler", lat: 41.001, lng: 28.86, timeZone: "Europe/Istanbul" },
  { city: "Istanbul", kind: "edge", area: "Başakşehir", lat: 41.093, lng: 28.802, timeZone: "Europe/Istanbul" },
  { city: "Rome", kind: "centre", area: "Pantheon", lat: 41.899, lng: 12.477, timeZone: "Europe/Rome" },
  { city: "Rome", kind: "residential", area: "Tuscolano", lat: 41.866, lng: 12.545, timeZone: "Europe/Rome" },
  { city: "Rome", kind: "edge", area: "Torre Angela", lat: 41.864, lng: 12.645, timeZone: "Europe/Rome" },
  { city: "Prague", kind: "centre", area: "Old Town", lat: 50.088, lng: 14.421, timeZone: "Europe/Prague" },
  { city: "Prague", kind: "residential", area: "Stodůlky", lat: 50.046, lng: 14.332, timeZone: "Europe/Prague" },
  { city: "Prague", kind: "edge", area: "Černý Most", lat: 50.108, lng: 14.58, timeZone: "Europe/Prague" },
  { city: "Mexico City", kind: "centre", area: "Centro Histórico", lat: 19.4326, lng: -99.1332, timeZone: "America/Mexico_City" },
  { city: "Mexico City", kind: "residential", area: "Narvarte", lat: 19.396, lng: -99.155, timeZone: "America/Mexico_City" },
  { city: "Mexico City", kind: "edge", area: "Iztapalapa", lat: 19.35, lng: -99.04, timeZone: "America/Mexico_City" },
  { city: "Nairobi", kind: "centre", area: "Central Business District", lat: -1.2864, lng: 36.8172, timeZone: "Africa/Nairobi" },
  { city: "Nairobi", kind: "residential", area: "South B", lat: -1.308, lng: 36.837, timeZone: "Africa/Nairobi" },
  { city: "Nairobi", kind: "edge", area: "Embakasi", lat: -1.32, lng: 36.9, timeZone: "Africa/Nairobi" },
];
