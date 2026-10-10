/**
 * Cities the desk demo offers when location is not available ("Generate a quest near me").
 * `tested`: a quest was generated there and passed the validator in a logged run. Update it when
 * the evals run in more cities; the screen marks the others "not tested yet".
 */
export type DeskCity = { id: string; name: string; area: string; lat: number; lng: number; tested: boolean };

export const DESK_CITIES: readonly DeskCity[] = [
  { id: "istanbul", name: "Istanbul", area: "Karaköy, below Galata Tower", lat: 41.0247, lng: 28.9744, tested: true },
  { id: "rome", name: "Rome", area: "around the Pantheon", lat: 41.8986, lng: 12.4769, tested: true },
  { id: "prague", name: "Prague", area: "Old Town Square", lat: 50.0875, lng: 14.4213, tested: true },
  { id: "lisbon", name: "Lisbon", area: "Baixa", lat: 38.7108, lng: -9.1366, tested: false },
  { id: "vienna", name: "Vienna", area: "around St. Stephen's", lat: 48.2085, lng: 16.3721, tested: false },
  { id: "barcelona", name: "Barcelona", area: "Gothic Quarter", lat: 41.3833, lng: 2.1766, tested: false },
];
