/**
 * What kind of place a result is, from its types (Google Maps) or its short description and
 * title (Wikipedia). Used to keep the game to public, visible things a player can walk to.
 */

/** A case-insensitive whole-word pattern that also works for Turkish letters (ç, ş, ı …). */
function words(pattern: string, prefix = ""): RegExp {
  return new RegExp(`${prefix}(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Not a place to send a player: private or full of people to photograph (schools, hotels,
 * shops, offices, consulates), roads and stations (player safety), and pages that are not
 * places at all (events, ships, organisations, works, people).
 */
const EXCLUDED = words(
  [
    "schools?", "gymnasium", "universit(?:y|ies)", "college", "kindergarten", "hospital", "clinic",
    "stations?", "bus stop", "terminal", "restaurants?", "caf[eé]s?", "coffee shop", "bars?", "pubs?",
    "nightclub", "hotels?", "hostel", "lodging", "shops?", "stores?", "boutique", "supermarket",
    "shopping", "mall", "company", "corporation", "agency", "board", "office", "ministry", "consulate",
    "embassy", "club", "team", "football(?:er)?", "stadium", "parking", "apartments?", "residence",
    "streets?", "road", "avenue", "boulevard", "highway", "motorway", "tunnel", "massacre", "attack",
    "bombing", "fire", "battle", "siege", "earthquake", "riot", "election", "ship", "vessel", "film", "novel",
    "album", "song", "band", "politician", "businessman", "writer", "poet", "painter", "real estate",
    "travel agency", "tour operator", "car rental", "atm", "pharmacy", "gym", "spa", "massage", "salon", "beauty",
    "archdiocese", "diocese", "eparchy",
    "okul(?:u)?", "lise(?:si)?", "otel(?:i)?", "lokanta(?:s[ıi])?", "kafe", "caddesi", "sokağ[ıi]",
  ].join("|"),
);

/**
 * A neighbourhood, district or former settlement ("Quarter in Marmara, Turkey", "Ancient suburb
 * of Byzantium"): its facts describe the area, not a stop. Matched at the start of a description.
 */
const AREA = words(
  "neighbou?rhood|quarter|quartier|arrondissement|district|suburb|municipality|province|region|town|village|settlement|mahalle(?:si)?|semt|ilçe",
  // Up to two leading words ("Former", "Ancient"), but not "in"/"of" ("Church in arrondissement …").
  "^(?:(?!(?:in|of|on|at|near)\\s)[\\p{L}-]+\\s+){0,2}",
);

/** Places with gates or hours (courtyards, gardens, parks): used only when open at play time. */
const GATED = words(
  [
    "courtyard", "gardens?", "parks?", "park[ıi]", "avlu(?:su)?", "bah[cç]e(?:si)?", "cemetery", "graveyard",
    "mezarl[ıi]ğ?[ıi]?k?", "botanical", "zoo", "madrasa", "medrese(?:si)?",
    "k[uü]lliye(?:si)?", "cloister",
  ].join("|"),
);

/** Things with outside details a player can see and photograph. */
const VISIBLE = words(
  [
    "fountain", "[cç]e[sş]me(?:si)?", "sebil(?:i)?", "monument", "statue", "memorial", "an[ıi]t[ıi]?",
    "tower", "kule(?:si)?", "mosque", "camii?", "church", "kilise(?:si)?", "synagogue", "sinagog(?:u)?",
    "landmark", "historic(?:al)?", "gate", "kap[ıi]s[ıi]", "bridge", "k[oö]pr[uü](?:s[uü])?", "tomb",
    "t[uü]rbe(?:si)?", "column", "obelisk", "clock", "han[ıi]?", "hamam[ıi]?", "bath", "pier",
    "iskele(?:si)?", "square", "meydan[ıi]?", "museum", "m[uü]ze(?:si)?", "buildings?", "inscription", "relief",
    "cathedral", "chapel", "basilica", "abbey", "temple", "shrine", "palace", "castle", "fortress", "fort",
    "walls?", "spire", "stairs", "staircase", "steps", "arcade", "lighthouse", "cistern", "aqueduct", "arch",
    "sculptur(?:e|al)", "mural", "plaque", "cemetery", "parks?", "gardens?", "courtyard", "plaza", "quay",
    "embankment", "tree", "theat(?:re|er)", "opera house", "library", "hall", "bazaar", "[cç]ar[sş][ıi]",
    "pasaj[ıi]?", "passage", "saray[ıi]?", "kale(?:si)?", "surlar[ıi]?", "kilise", "medrese(?:si)?",
    "k[uü]lliye(?:si)?", "hamam", "sinagogu",
  ].join("|"),
);

export const isExcluded = (text: string) => EXCLUDED.test(text);
export const isArea = (text: string) => AREA.test(text);
export const isGated = (text: string) => GATED.test(text);
export const isVisible = (text: string) => VISIBLE.test(text);
