import { describe, expect, it } from "vitest";
import { fixtures, KARAKOY, testDeps } from "./__fixtures__";
import { cityFromAddresses, inLanguage, parseSearchFacts, searchQuery, skippedHost } from "./facts";
import { mapsUrl, parseMapsPlaces } from "./places";
import { parseWikipedia, placeName, wikiNearby, wikiUrl } from "./wikipedia";

const play = { start: new Date("2026-10-10T11:00:00Z"), minutes: 25, timeZone: "Europe/Istanbul" };

describe("Google Maps places (recorded Karaköy responses)", () => {
  const landmark = parseMapsPlaces(fixtures.mapsLandmark(), { center: KARAKOY, radiusM: 900, query: "historical landmark", play });
  const fountain = parseMapsPlaces(fixtures.mapsFountain(), { center: KARAKOY, radiusM: 900, query: "fountain monument", play });

  it("drops results outside the radius", () => {
    // The German Fountain is in Sultanahmet, about 2 km away.
    expect(fountain.places.map((p) => p.name)).toEqual(["Matbah Emini Hasan Aga Fountain"]);
    for (const p of [...landmark.places, ...fountain.places]) expect(p.distanceM).toBeLessThanOrEqual(900);
  });

  it("drops businesses (a massage spa in an old bath) and keeps landmarks", () => {
    const names = landmark.places.map((p) => p.name);
    expect(names).toContain("Galata Tower");
    expect(names).toContain("Kamondo Stairs");
    expect(names).not.toContain("Tarihi Çeşme Hamamı 1720");
  });

  it("keeps the fields the game uses and links each place to Google Maps", () => {
    const tower = landmark.places.find((p) => p.name === "Galata Tower")!;
    expect(tower).toMatchObject({
      key: "maps:ChIJQ3x3p-e5yhQRCzOLzD3Pdkw",
      sourceUrl: mapsUrl("ChIJQ3x3p-e5yhQRCzOLzD3Pdkw"),
      sources: ["serpapi-maps"],
      types: ["Historical landmark", "Tourist attraction"],
      gated: false,
      openNow: true, // Saturday 14:00 in Istanbul, open 8:30 AM–10 PM
    });
    expect(tower.location).toEqual({ lat: 41.025569, lng: 28.9741286 });
  });

  it("turns a Maps summary into a fact with its query and link", () => {
    const fact = fountain.facts[0];
    expect(fact).toMatchObject({ source: "serpapi-maps", query: "fountain monument", placeKey: "maps:ChIJyc_vdee5yhQRru_i0fRegz4" });
    expect(fact.text).toMatch(/2 facades with inscriptions/);
    expect(fact.sourceUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/place\//);
  });

  it("skips a gated place only when its hours say it is closed during the walk", () => {
    const payload = {
      local_results: [
        {
          title: "Test Garden",
          place_id: "garden-1",
          gps_coordinates: { latitude: 41.0249, longitude: 28.9746 },
          types: ["Garden"],
          operating_hours: { saturday: "9 AM–1 PM" },
        },
        {
          title: "Test Park",
          place_id: "park-1",
          gps_coordinates: { latitude: 41.0249, longitude: 28.9747 },
          type: "Park",
        },
        {
          title: "Test Fountain",
          place_id: "fountain-1",
          gps_coordinates: { latitude: 41.0249, longitude: 28.9748 },
          type: "Fountain",
          operating_hours: { saturday: "Closed" },
        },
      ],
    };
    const r = parseMapsPlaces(payload, { center: KARAKOY, radiusM: 900, query: "q", play });
    expect(r.skippedClosed).toEqual(["Test Garden"]); // closed at 14:00
    expect(r.places.map((p) => [p.name, p.gated, p.openNow])).toEqual([
      ["Test Park", true, undefined], // no hours: kept
      ["Test Fountain", false, false], // not gated: hours never drop it
    ]);
  });
});

describe("Wikipedia GeoSearch (recorded Karaköy response)", () => {
  const query = "en.wikipedia.org pages within 900 m of 41.025,28.974";
  const r = parseWikipedia(fixtures.wikipedia(), { center: KARAKOY, radiusM: 900, lang: "en", query });

  it("asks for coordinates of every page, intros as plain text, and page URLs", () => {
    const url = new URL(wikiUrl("en", { lat: 41.025, lng: 28.974 }, 900));
    expect(url.host).toBe("en.wikipedia.org");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      generator: "geosearch",
      ggscoord: "41.025|28.974",
      ggsradius: "900",
      ggslimit: "20",
      colimit: "max",
      exintro: "1",
      explaintext: "1",
      inprop: "url",
    });
  });

  it("keeps places a player can visit and drops schools, restaurants, streets, stations and events", () => {
    const names = r.places.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Arap Mosque", "Italian Synagogue", "Church of Saint Benoit"]));
    for (const dropped of ["St. George's Austrian High School", "Neolokal", "Bankalar Caddesi", "Karaköy", "Neve Shalom Synagogue massacre"]) {
      expect(names).not.toContain(dropped);
    }
    expect(names.some((n) => n.includes("Tünel"))).toBe(false);
  });

  it("takes coordinates from the API and facts from intro sentences, each with page link and query", () => {
    const arap = r.places.find((p) => p.name === "Arap Mosque")!;
    expect(arap.location).toEqual({ lat: 41.02432, lng: 28.97104 });
    const facts = r.facts.filter((f) => f.placeKey === arap.key);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    for (const f of facts) {
      expect(f).toMatchObject({ source: "wikipedia", query, sourceUrl: "https://en.wikipedia.org/wiki/Arap_Mosque" });
      expect(f.text.length).toBeLessThanOrEqual(300);
    }
  });

  it("keeps a few neighbourhood sentences as area facts (no place)", () => {
    const area = r.facts.filter((f) => !f.placeKey);
    expect(area.length).toBeGreaterThan(0);
    expect(area.some((f) => f.sourceUrl.endsWith("/Karak%C3%B6y"))).toBe(true);
  });

  it("drops Wikipedia's disambiguation from names", () => {
    expect(placeName("Italian Synagogue (Istanbul)")).toBe("Italian Synagogue");
    expect(placeName("Church of Saint Benoit, Istanbul")).toBe("Church of Saint Benoit");
  });

  it("calls the API once with the user agent, then serves the cache", async () => {
    const { deps, fetch } = testDeps({ env: { WIKIPEDIA_USER_AGENT: "test-agent/1.0 (test@example.org)" } as unknown as NodeJS.ProcessEnv });
    const log = { lookups: [], warnings: [] as string[] };
    const a = await wikiNearby(deps, { center: KARAKOY, lang: "en", radiusM: 900 }, log);
    const b = await wikiNearby(deps, { center: KARAKOY, lang: "en", radiusM: 900 }, log);
    expect(fetch.calls).toHaveLength(1);
    expect(new Headers(fetch.calls[0].init?.headers).get("user-agent")).toBe("test-agent/1.0 (test@example.org)");
    expect(b).toEqual(a);
    expect(log.lookups.map((l: { outcome: string }) => l.outcome)).toEqual(["fetched", "cached"]);
  });

  it("returns null and a warning when Wikipedia fails", async () => {
    const { deps } = testDeps({ fetch: (async () => new Response("busy", { status: 503 })) as typeof fetch });
    const log = { lookups: [], warnings: [] as string[] };
    expect(await wikiNearby(deps, { center: KARAKOY, lang: "en", radiusM: 900 }, log)).toBeNull();
    expect(log.warnings[0]).toMatch(/HTTP 503/);
  });
});

describe("Google Search facts (recorded Karaköy responses)", () => {
  const parse = (query: string, placeName: string) =>
    parseSearchFacts(fixtures.search(query), { placeKey: "k", placeName, query, lang: "en" });

  it("builds the query from the place and the city in the Maps addresses", () => {
    expect(cityFromAddresses(["Bereketzade, 34421 Beyoğlu/İstanbul, Türkiye", "Arap Cami, 34421 Beyoğlu/İstanbul, Türkiye"])).toBe("İstanbul");
    expect(cityFromAddresses(["350 5th Ave, New York, NY 10118"])).toBe("New York");
    expect(cityFromAddresses(["Pl. du Trocadéro, 75016 Paris, France"])).toBe("Paris");
    expect(searchQuery("Galata Tower", "İstanbul")).toBe("Galata Tower İstanbul history");
    expect(searchQuery("Ashkenazi Synagogue of Istanbul", "Istanbul")).toBe("Ashkenazi Synagogue of Istanbul history");
  });

  it("every fact has its link and the exact query", () => {
    const facts = parse("Galata Tower İstanbul history", "Galata Tower");
    expect(facts.length).toBeGreaterThanOrEqual(2);
    for (const f of facts) {
      expect(f).toMatchObject({ source: "serpapi-search", query: "Galata Tower İstanbul history", placeKey: "k" });
      expect(f.sourceUrl).toMatch(/^https?:\/\//);
    }
    // Wikipedia's infobox fragment ("medieval Genoese tower. … 678 years ago") is not a fact.
    expect(facts.some((f) => /years ago/.test(f.text))).toBe(false);
  });

  it("uses the knowledge graph description with its source link", () => {
    const facts = parse("Kamondo Stairs İstanbul history", "Kamondo Stairs");
    expect(facts[0]).toMatchObject({ sourceUrl: "https://en.wikipedia.org/wiki/Camondo_Stairs", sourceTitle: "Wikipedia" });
    // Raw hours and Google's internal ids are not facts.
    expect(facts.some((f) => /Raw hours|Place id/i.test(f.text))).toBe(false);
  });

  it("skips social media, stock photos, reviews, other languages and other places", () => {
    const all = [
      ...parse("Arap Mosque İstanbul history", "Arap Mosque"),
      ...parse("Bereketzade Ali Efendi Mosque İstanbul history", "Bereketzade Ali Efendi Mosque"),
      ...parse("Church of Saints Peter and Paul İstanbul history", "Church of Saints Peter and Paul"),
      ...parse("Jewish Museum of Turkey İstanbul history", "Jewish Museum of Turkey"),
      ...parse("Matbah Emini Hasan Aga Fountain İstanbul history", "Matbah Emini Hasan Aga Fountain"),
    ];
    for (const f of all) {
      expect(skippedHost(f.sourceUrl), f.sourceUrl).toBe(false);
      expect(f.text).not.toMatch(/\b(?:you|I|we)\b|Address:|Day \d/);
      // No French, Italian or Russian snippets (hl=en still returns them).
      expect(f.text).not.toMatch(/\p{Script=Cyrillic}|\b(?:sono|stata|costruita|été|plusieurs|détruite)\b/u);
    }
    expect(all.some((f) => /instagram|alamy|tripadvisor|trip\.com|yandex|aroundus|hagia-sophia/.test(f.sourceUrl))).toBe(false);
  });

  it("knows which hosts to skip and which language a snippet is in", () => {
    expect(skippedHost("https://www.instagram.com/popular/arap-mosque/")).toBe(true);
    expect(skippedHost("https://my.trip.com/moments/x")).toBe(true);
    expect(skippedHost("https://www.tripadvisor.co.nz/Attraction_Review")).toBe(true);
    expect(skippedHost("https://en.wikipedia.org/wiki/Galata_Tower")).toBe(false);
    expect(inLanguage("Galata Tower was built by the Genoese in 1348.", "en")).toBe(true);
    expect(inLanguage("La structure d'origine a été détruite plusieurs fois par des incendies.", "en")).toBe(false);
    expect(inLanguage("Fontana sono stata costruita in pietra squadrata in stile classico.", "en")).toBe(false);
    expect(inLanguage("Рейтинг 4,7 на основе 40 оценок", "en")).toBe(false);
    expect(inLanguage("Çeşme 1649 yılında Hasan Ağa tarafından inşa edilmiştir ve bir yüzü caddeye bakar.", "tr")).toBe(true);
  });
});
