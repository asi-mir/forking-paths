/**
 * Cities the desk demo offers when location is not available ("Generate a quest near me").
 * `tested`: a quest was generated there and passed the validator in a logged run. Update it when
 * the evals run in more cities; the screen marks the others "not tested yet".
 */
export type DeskCity = { id: string; name: string; area: string; lat: number; lng: number; tested: boolean };

export const DESK_CITIES: readonly DeskCity[] = [
  { id: "istanbul", name: "Istanbul", area: "Karaköy, below Galata Tower", lat: 41.0247, lng: 28.9744, tested: true },
  { id: "london", name: "London", area: "Trafalgar Square", lat: 51.508, lng: -0.1281, tested: true },
  { id: "new-york", name: "New York", area: "Flatiron", lat: 40.7411, lng: -73.9897, tested: true },
  { id: "berlin", name: "Berlin", area: "Gendarmenmarkt, Mitte", lat: 52.5136, lng: 13.3927, tested: true },
  { id: "san-francisco", name: "San Francisco", area: "Ferry Building", lat: 37.7955, lng: -122.3937, tested: true },
  { id: "lisbon", name: "Lisbon", area: "Baixa", lat: 38.7105, lng: -9.1378, tested: true },
  { id: "rome", name: "Rome", area: "around the Pantheon", lat: 41.8986, lng: 12.4769, tested: true },
  { id: "prague", name: "Prague", area: "Old Town Square", lat: 50.0875, lng: 14.4213, tested: true },
];
