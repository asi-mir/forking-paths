import type { z } from "zod";
import { distanceM, type LatLng, walkMinutes } from "@/lib/geo";
import { routesOf } from "./routes";
import {
  type Candidate,
  CandidateSchema,
  type Cue,
  CueSchema,
  CUES,
  type Fact,
  FactSchema,
  type Lang,
  type Link,
  type Place,
  type Quest,
  QuestSchema,
  type StopsPerRun,
  type ValidationRecord,
  type WriterLink,
  type WriterOutput,
  WriterOutputSchema,
} from "./schema";

/**
 * The quest validator: grounding, safety, route and distance rules.
 *
 * Every error is one plain sentence that names the place, link or line at fault, so the
 * whole list can go back to the writer for one repair.
 */

export type ValidateOptions = {
  center: LatLng; // the point the quest was generated for
  minutes: number; // the walk length the player picked (15 or 25)
  lang?: Lang;
  stopsPerRun?: StopsPerRun; // default: from minutes (see stopsForMinutes)
  maxPlaces?: number; // default 6
  maxHopM?: number; // default 250: every stop → stop
  maxStartM?: number; // default 180: centre → start (the centre is rounded, up to ~70 m off the player)
  maxRadiusM?: number; // default 900: every place from the centre
  maxClueWords?: number; // default 30
  firstTryErrors?: string[]; // set when this is the repaired draft: recorded in quest.validation
};

export type ValidateResult = { ok: true; quest: Quest } | { ok: false; errors: string[] };

/**
 * `maxStartM` is the hop from the player to the start, less the slack of the rounded centre
 * (3 decimals: up to ~70 m at Istanbul's latitude), so the real first hop stays within 250 m.
 */
export const LIMITS = { maxPlaces: 6, maxHopM: 250, maxStartM: 180, maxRadiusM: 900, maxClueWords: 30 };

/** 15 minutes → 3 stops (one fork); 25 minutes → 4 stops (two forks). */
export function stopsForMinutes(minutes: number): StopsPerRun {
  return minutes >= 25 ? 4 : 3;
}

// ---------------------------------------------------------------------------
// Text rules (exported: the narrator's bridge lines are checked with them at play time)

/**
 * Numbers written with digits, normalised ("1,500" → "1500", "18th" → "18", "1550–1557" →
 * "1550" and "1557", "1,5" → "1.5"). A comma or dot is a thousands separator only when
 * exactly three digits follow it; with one or two digits it is a decimal point; otherwise
 * it separates two numbers ("1557,1558" → "1557" and "1558"). Numbers written in words
 * ("eighteenth", "three") are NOT checked: matching them reliably across languages is not
 * worth the false rejections.
 */
export function numbersIn(text: string): string[] {
  return numberTokens(text).map((t) => t.value);
}

const NUMBER = /(\d{1,3}(?:[.,]\d{3})+(?!\d)|\d+[.,]\d{1,2}(?!\d)|\d+)(?:st|nd|rd|th|s)?/gi;

/** Like numbersIn, but keeps each number as written ("19th", "1,500") for error messages. */
function numberTokens(text: string): { raw: string; value: string }[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const digits = m[1];
    const thousands = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits);
    return { raw: m[0], value: thousands ? digits.replace(/[.,]/g, "") : digits.replace(",", ".") };
  });
}

/** IDs written into spoken text ("as F3 says") — they belong in factIds, not in the line. */
export function idsIn(text: string): string[] {
  return text.match(/\b[FP]\d+\b/g) ?? [];
}

const ART = new Set([
  "statue", "statues", "carving", "carvings", "carved", "relief", "reliefs", "figure",
  "figures", "mosaic", "mosaics", "painting", "painted", "portrait", "sculpture", "bust",
  "mural", "fresco", "engraving", "silhouette", "image", "emblem", "plaque", "sign",
]);
const PEOPLE = new Set([
  "person", "people", "man", "men", "woman", "women", "child", "children", "kid", "kids",
  "baby", "babies", "stranger", "strangers", "passer-by", "passers-by", "passerby",
  "pedestrian", "pedestrians", "vendor", "vendors", "seller", "sellers", "shopkeeper",
  "shopkeepers", "fisherman", "fishermen", "guard", "guards", "worker", "workers", "local",
  "locals", "tourist", "tourists", "crowd", "crowds", "face", "faces", "someone", "somebody",
  "anyone", "everyone", "yourself", "couple", "couples", "family", "families", "police",
  "officer", "officers", "resident", "residents", "owner", "owners", "player", "players",
  "boy", "boys", "girl", "girls", "musician", "musicians", "busker", "buskers", "waiter",
  "waiters", "waitress", "waitresses", "barber", "barbers", "worshipper", "worshippers",
  "worshiper", "worshipers", "fisher", "fishers", "angler", "anglers", "simitçi",
]);
/**
 * Pronouns count only right after the verb ("snap him") or after "photo of" ("a photo of
 * her"): "photograph one of them" usually means one of the details.
 */
const PRONOUNS = new Set(["him", "her", "them", "us", "me"]);
const PHOTO_VERB = /^(photograph\w*|photo|photos|picture|pictures|snap\w*|shoot|film|capture|frame)$/;

/** True when the text asks the player to photograph a person (statues and carvings are fine). */
function asksForPhotoOfPeople(text: string): string | null {
  if (/\bselfies?\b/i.test(text)) return "selfie";
  const words = text.toLowerCase().match(/[\p{L}'-]+/gu) ?? [];
  for (let i = 0; i < words.length; i++) {
    if (!PHOTO_VERB.test(words[i])) continue;
    const next = words[i + 1] === "of" ? words[i + 2] : words[i + 1];
    if (next && PRONOUNS.has(next)) return `${words[i]} … ${next}`;
    for (const w of words.slice(i + 1, i + 6)) {
      if (ART.has(w)) break;
      if (PEOPLE.has(w)) return `${words[i]} … ${w}`;
    }
  }
  return null;
}

type BlockRule = { pattern: RegExp; why: string; fix: string };

/**
 * "onto the street" after a verb of facing describes a thing, not the player: "the face that
 * looks onto the street", "a window opening onto the road". Those lines are not blocked.
 */
const FACES = String.raw`(?<!\b(?:looks?|looking|looked|faces?|facing|faced|opens?|opening|opened|gives?|giving|gave)\s+)`;

/** Road words, English and Turkish ("caddesi", "sokağı"); ends where the word ends. */
const ROAD_WORDS = String.raw`(?:road|street|avenue|boulevard|highway|motorway|caddesi|cadde|sokak|sokağı|tram\s*(?:line|tracks?)|tracks?|junction|intersection)(?![\p{L}])`;

/** The safety block list. English first; the Turkish entries are a starting set. */
const SAFETY_RULES: BlockRule[] = [
  {
    // Up to three words between the verb and the road word: "cross Necatibey Avenue",
    // "cross Kemeraltı Caddesi", "cross the busy main road".
    pattern: new RegExp(
      String.raw`\bcross(?:es|ed|ing)?\s+(?:over\s+)?(?:[\p{L}'’-]+\s+){0,3}${ROAD_WORDS}`,
      "iu",
    ),
    why: "sends the player across a road",
    fix: "keep the player on the pavement",
  },
  {
    pattern: new RegExp(
      String.raw`\b(?:across|over)\s+(?:(?!from\s)[\p{L}'’-]+\s+){0,3}${ROAD_WORDS}`,
      "iu",
    ),
    why: "sends the player across a road",
    fix: "keep the player on the pavement",
  },
  {
    pattern: new RegExp(
      String.raw`\bcross(?:es|ed|ing)?\s+(?:over|to\s+the\s+(?:other|far|opposite)\s+side)\b|\b(?:other|far|opposite)\s+side\s+of\s+(?:the\s+)?(?:[\p{L}'’-]+\s+){0,2}${ROAD_WORDS}`,
      "iu",
    ),
    why: "sends the player across a road",
    fix: "keep the player on the pavement",
  },
  {
    pattern: new RegExp(
      String.raw`${FACES}\b(?:onto|into|middle\s+of)\s+(?:the\s+)?(?:road|carriageway|highway|motorway|tram\s*(?:line|tracks?)|railway|rail\s+tracks?)\b`,
      "i",
    ),
    why: "puts the player on a road or track",
    fix: "keep the player on the pavement",
  },
  {
    // "in the road" only after a movement verb: "the plaque is set in the road surface" is fine.
    pattern:
      /\b(?:walk|go|step|stand|wait|stop|head|stay)(?:s|ing)?\s+in\s+(?:the\s+)?(?:road|street|carriageway|tram\s*(?:line|tracks?)|railway|rail\s+tracks?)\b/i,
    why: "puts the player on a road or track",
    fix: "keep the player on the pavement",
  },
  {
    pattern: new RegExp(String.raw`${FACES}\b(?:onto|into|middle\s+of)\s+(?:the\s+)?street\b`, "i"),
    why: "puts the player on the street",
    fix: "keep the player on the pavement",
  },
  {
    pattern: /\b(?:off|from)\s+the\s+(?:pavement|kerb|curb|sidewalk)\b/i,
    why: "takes the player off the pavement",
    fix: "keep the player on the pavement",
  },
  {
    // Only lines that put the player in traffic: "turn left at the traffic lights" is a landmark.
    pattern:
      /\b(?:(?:through|into|between|among|across|in)\s+(?:the\s+)?(?:\w+\s+)?traffic|(?:dodg|weav|wait|watch|duck)\w*\s+(?:for\s+|through\s+)?(?:a\s+gap\s+in\s+)?(?:the\s+)?(?:oncoming\s+)?traffic|gap\s+in\s+(?:the\s+)?traffic)\b/i,
    why: "sends the player into traffic",
    fix: "lead the player along quiet pavements",
  },
  { pattern: /\b(?:jaywalk\w*|highway|motorway|freeway|carriageway)\b/i, why: "mentions a major road", fix: "lead the player along quiet pavements" },
  { pattern: /\b(?:private|trespass\w*|backyard|back\s+yard)\b/i, why: "points at private property", fix: "use only public places" },
  {
    pattern: /\b(?:someone|somebody|people)'?s\s+(?:house|home|flat|apartment|garden|yard|balcony|door)\b/i,
    why: "points at someone's home",
    fix: "use only public places",
  },
  {
    pattern: /\b(?:climb|jump|hop|scale)\w*\s+(?:over\s+|up\s+|onto\s+)?(?:the\s+|a\s+)?(?:fence|wall|gate|railings?|barrier|roof)\b/i,
    why: "asks the player to climb a barrier",
    fix: "the player stays on open public ground",
  },
  { pattern: /\b(?:residents\s+only|staff\s+only|no\s+entry|keep\s+out)\b/i, why: "points past a no-entry sign", fix: "use only public places" },
  {
    pattern:
      /\b(?:enter|enters|entering|go\s+inside|step\s+inside|walk\s+inside|head\s+inside)\b|\b(?:walk|go|step|head|slip|wander)(?:s|ing)?\s+into\s+(?:the\s+|a\s+)?(?:\w+\s+)?(?:courtyard|yard|building|shop|house|hall)\b/i,
    why: "tells the player to enter a building or property",
    fix: "the player stays outside, on public ground",
  },
  // Turkish starting set: cross the road, traffic, private property, go inside.
  { pattern: /(?:yolun\s+karşısına|karşıya\s+geç|trafik|özel\s+mülk|içeri\s+gir)/iu, why: "points at a road, traffic, private property or an entrance", fix: "keep the player outside, on public pavement" },
];

const PEOPLE_FIX = "ask for a detail of the place, never a person";

/** The fix text of every safety rule. Each must pass safetyIssues itself, or a repair that copies it fails again. */
export const SAFETY_FIXES: readonly string[] = [...new Set([...SAFETY_RULES.map((r) => r.fix), PEOPLE_FIX])];

/** Safety problems in a line the player hears or reads (empty when the line is safe). */
export function safetyIssues(text: string): string[] {
  const issues: string[] = [];
  for (const rule of SAFETY_RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      const issue = `${rule.why} ("${m[0]}"); ${rule.fix}`;
      if (!issues.includes(issue)) issues.push(issue);
    }
  }
  const people = asksForPhotoOfPeople(text);
  if (people) issues.push(`asks the player to photograph people ("${people}"); ${PEOPLE_FIX}`);
  return issues;
}

const COMPASS_EN =
  /(?<![\p{L}-])(?:(?:north|south)(?:[\s-]?(?:east|west))?|east|west)(?:ward|wards|ern|erly|bound)?(?![\p{L}])/giu;
const COMPASS_TR =
  /(?<![\p{L}])(?:(?:kuzey|güney)(?:doğu|batı)?(?:e|ye|de|den|inde|ine|ne)?|(?:doğu|batı)(?:ya|da|dan|sı|sında|sına)?)(?![\p{L}])/giu;

/**
 * Compass words in a line ("north", "south-east", "westward"). Clues use landmarks instead.
 * Place names are not directions: the given names are removed first ("Northern Pier"), and a
 * capitalised compass word right before another capitalised word ("West Gate") is skipped.
 */
export function compassWords(text: string, placeNames: string[] = []): string[] {
  let t = text;
  for (const name of placeNames) {
    if (name.trim()) t = t.replace(new RegExp(escapeRegExp(name.trim()), "giu"), " ");
  }
  const found: string[] = [];
  for (const re of [COMPASS_EN, COMPASS_TR]) {
    for (const m of t.matchAll(re)) {
      const rest = t.slice(m.index + m[0].length);
      if (/^\p{Lu}/u.test(m[0]) && /^[\s-]+\p{Lu}/u.test(rest)) continue;
      found.push(m[0]);
    }
  }
  return found;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------
// The validator

type Role = "fork" | "before-answer" | "answer";

const arrow = (route: string[]) => route.join(" → ");
const list = (ids: Iterable<string>) => [...ids].join(", ");

export function validateQuest(
  writerOutput: unknown,
  facts: Fact[],
  candidates: Candidate[],
  opts: ValidateOptions,
): ValidateResult {
  const input = checkResearchData(facts, candidates);
  if (input.length) return { ok: false, errors: input };

  const parsed = WriterOutputSchema.safeParse(writerOutput);
  if (!parsed.success) return { ok: false, errors: zodErrors("writer output", parsed.error) };
  const w = parsed.data;

  const n = opts.stopsPerRun ?? stopsForMinutes(opts.minutes);
  const maxPlaces = opts.maxPlaces ?? LIMITS.maxPlaces;
  const maxHopM = opts.maxHopM ?? LIMITS.maxHopM;
  const maxRadiusM = opts.maxRadiusM ?? LIMITS.maxRadiusM;
  const maxClueWords = opts.maxClueWords ?? LIMITS.maxClueWords;

  const errors: string[] = [];
  const add = (e: string) => {
    if (!errors.includes(e)) errors.push(e);
  };

  const factById = new Map(facts.map((f) => [f.id, f]));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const placeById = new Map(w.places.map((p) => [p.id, p]));
  const candidateNames = candidates.map((c) => c.name);

  // --- Places -------------------------------------------------------------
  const seen = new Set<string>();
  for (const p of w.places) {
    if (seen.has(p.id)) add(`${p.id} is listed twice in places; list each place once.`);
    seen.add(p.id);
  }
  if (placeById.size > maxPlaces) {
    add(`The quest uses ${placeById.size} places; use at most ${maxPlaces}.`);
  }
  for (const p of placeById.values()) {
    const c = candidateById.get(p.id);
    if (!c) {
      add(`${p.id} is not one of the candidate places (${list(candidateById.keys())}); use only those.`);
      continue;
    }
    if (!facts.some((f) => f.placeId === p.id)) {
      add(`${p.id} (${c.name}) has no fetched fact of its own; pick a candidate place that has facts.`);
    }
    const fromCentre = distanceM(opts.center, c.location);
    if (fromCentre > maxRadiusM) {
      add(`${p.id} (${c.name}) is ${Math.round(fromCentre)} m from the quest centre; every place must be within ${maxRadiusM} m.`);
    }
    for (const l of p.links) {
      if (!placeById.has(l.to)) {
        add(`${p.id} links to ${l.to}, which is not one of the quest's places (${list(placeById.keys())}).`);
      }
    }
  }
  const startOk = placeById.has(w.startPlaceId);
  const answerOk = placeById.has(w.answerPlaceId);
  if (!startOk) add(`startPlaceId ${w.startPlaceId} is not one of the quest's places.`);
  if (!answerOk) add(`answerPlaceId ${w.answerPlaceId} is not one of the quest's places.`);
  if (w.startPlaceId === w.answerPlaceId) add(`startPlaceId and answerPlaceId are both ${w.startPlaceId}; they must differ.`);

  // --- Lines: length, safety, compass words, IDs in text -------------------
  const spoken: { label: string; text: string; directions: boolean }[] = [
    { label: "The briefing", text: w.briefing, directions: false },
    { label: "The mystery question", text: w.mystery.question, directions: false },
    { label: "The mystery answer", text: w.mystery.answer, directions: false },
    { label: "The finale", text: w.finale.text, directions: false },
  ];
  for (const p of w.places) {
    const words = wordCount(p.clue);
    if (words > maxClueWords) {
      add(`${p.id} clue has ${words} words; keep it to ${maxClueWords} or fewer.`);
    }
    spoken.push(
      { label: `${p.id} clue`, text: p.clue, directions: true },
      { label: `${p.id} look line`, text: p.look, directions: false },
      { label: `${p.id} hint`, text: p.hint, directions: true },
      { label: `${p.id} reveal`, text: p.reveal.text, directions: false },
      ...p.links.map((l) => ({ label: `${p.id} → ${l.to} link reason`, text: l.reason, directions: true })),
    );
  }
  for (const { label, text, directions } of spoken) {
    for (const issue of safetyIssues(text)) add(`${label} ${issue}.`);
    if (directions) {
      const compass = compassWords(text, candidateNames);
      if (compass.length) {
        add(`${label} uses the compass word "${compass[0]}"; give a landmark direction instead ("toward the water").`);
      }
    }
    const ids = idsIn(text);
    if (ids.length) add(`${label} writes the ID ${ids[0]} in its text; put IDs only in factIds.`);
  }

  // --- Grounding: cited IDs and numbers ----------------------------------
  const factNumbers = (ids: string[]) =>
    new Set(ids.flatMap((id) => numbersIn(factById.get(id)?.text ?? "")));

  const checkCited = (label: string, texts: string[], factIds: string[]) => {
    if (factIds.length === 0) {
      add(`${label} cites no fact; cite the IDs of the facts it states.`);
      return;
    }
    const unknown = factIds.filter((id) => !factById.has(id));
    for (const id of unknown) add(`${label} cites ${id}, which is not one of the facts.`);
    if (unknown.length) return; // its numbers are checked once it cites real facts
    const known = factNumbers(factIds);
    for (const text of texts) {
      for (const num of numberTokens(text.replace(/\b[FP]\d+\b/g, ""))) {
        if (!known.has(num.value)) {
          add(`${label} says ${num.raw}, which is not in its cited facts (${list(factIds)}); use only numbers from those facts.`);
        }
      }
    }
  };

  checkCited("The mystery", [w.mystery.question, w.mystery.answer], w.mystery.factIds);
  checkCited("The finale", [w.finale.text], w.finale.factIds);
  for (const p of w.places) {
    checkCited(`${p.id} reveal`, [p.reveal.text], p.reveal.factIds);
    for (const l of p.links) checkCited(`${p.id} → ${l.to} link reason`, [l.reason], l.factIds);

    const c = candidateById.get(p.id);
    const own = facts.filter((f) => f.placeId === p.id).map((f) => f.id);
    if (!c || own.length === 0) continue; // reported above
    // The reveal is the place's own story: it must cite at least one fact of that place.
    const revealKnown = p.reveal.factIds.length > 0 && p.reveal.factIds.every((id) => factById.has(id));
    if (revealKnown && !p.reveal.factIds.some((id) => own.includes(id))) {
      add(`${p.id} reveal cites no fact of ${p.id} (its facts: ${list(own)}); cite at least one of them.`);
    }
    // Clue, look line and hint cite nothing: their numbers must come from the place's own facts
    // (or its name, e.g. "Pier 7").
    const ownNumbers = new Set([...factNumbers(own), ...numbersIn(c.name)]);
    for (const [what, text] of [["clue", p.clue], ["look line", p.look], ["hint", p.hint]] as const) {
      for (const num of numberTokens(text.replace(/\b[FP]\d+\b/g, ""))) {
        if (!ownNumbers.has(num.value)) {
          add(`${p.id} ${what} says ${num.raw}, which is in none of ${p.id}'s facts; leave it out or use a number from them.`);
        }
      }
    }
  }
  // The briefing cites nothing, so its numbers must at least appear in some fact of the quest.
  const allNumbers = factNumbers(facts.map((f) => f.id));
  for (const num of numberTokens(w.briefing.replace(/\b[FP]\d+\b/g, ""))) {
    if (!allNumbers.has(num.value)) add(`The briefing says ${num.raw}, which is in none of the facts; leave numbers out of the briefing or use one from a fact.`);
  }
  if (answerOk) {
    const answerFacts = facts.filter((f) => f.placeId === w.answerPlaceId).map((f) => f.id);
    if (!w.mystery.factIds.some((id) => answerFacts.includes(id))) {
      add(`The mystery cites no fact of the answer place ${w.answerPlaceId}${answerFacts.length ? ` (its facts: ${list(answerFacts)})` : ""}; its answer must be a fact of that place.`);
    }
  }

  // --- Routes -----------------------------------------------------------
  const goodRoutes: string[][] = [];
  if (startOk) {
    const shape =
      n === 3
        ? "start (a fork) → one of its links (one link) → the answer"
        : "start (a fork) → a fork → a stop with one link → the answer";
    const routes = routesOf(w);
    const onRoute = new Set(routes.flat());
    for (const route of routes) {
      const last = route[route.length - 1];
      if (route.indexOf(last) !== route.length - 1) {
        add(`Route ${arrow(route)} visits ${last} twice; no route may come back to a place.`);
        continue;
      }
      if (!placeById.has(last)) continue; // reported above as a link to an unknown place
      let ok = true;
      if (route.length !== n) {
        add(`Route ${arrow(route)} has ${route.length} stops; a ${n}-stop quest needs exactly ${n}: ${shape}.`);
        ok = false;
      }
      if (last !== w.answerPlaceId) {
        add(`Route ${arrow(route)} ends at ${last}, not at the answer place ${w.answerPlaceId}; every route must end there.`);
        ok = false;
      }
      if (ok) goodRoutes.push(route);
    }
    for (const id of placeById.keys()) {
      if (!onRoute.has(id)) add(`${id} is on no route from the start ${w.startPlaceId}; link to it or drop it.`);
    }

    // A place's role comes from its stop number on the routes that have the right shape.
    // (On two such routes a place is always the same stop: the routes after it are the same.)
    const roles = new Map<string, { role: Role; stop: number }>();
    for (const route of goodRoutes) {
      route.forEach((id, i) => {
        const role: Role = i === n - 1 ? "answer" : i === n - 2 ? "before-answer" : "fork";
        roles.set(id, { role, stop: i + 1 });
      });
    }
    for (const [id, { role, stop }] of roles) {
      const place = placeById.get(id)!;
      if (role === "fork") checkFork(place.id, place.links, stop, n, add);
      if (role === "before-answer") {
        const tos = place.links.map((l) => l.to);
        if (tos.length !== 1 || tos[0] !== w.answerPlaceId) {
          add(`${id} is the stop before the answer, so it needs exactly one link, to the answer place ${w.answerPlaceId} (it has ${tos.length}${tos.length ? `: ${list(tos)}` : ""}).`);
        }
      }
    }
  }
  const answer = placeById.get(w.answerPlaceId);
  if (answer && answer.links.length > 0) {
    add(`The answer place ${answer.id} has ${answer.links.length} link(s); it must have none.`);
  }

  // --- Distance ---------------------------------------------------------
  const loc = (id: string) => candidateById.get(id)?.location;
  const startLoc = loc(w.startPlaceId);
  if (startOk && startLoc) {
    const d = distanceM(opts.center, startLoc);
    const maxStartM = opts.maxStartM ?? LIMITS.maxStartM;
    if (d > maxStartM) add(`The start ${w.startPlaceId} is ${Math.round(d)} m from the quest centre; it must be within ${maxStartM} m.`);
  }
  for (const p of placeById.values()) {
    for (const l of p.links) {
      const a = loc(p.id);
      const b = loc(l.to);
      if (!a || !b) continue;
      const d = distanceM(a, b);
      if (d > maxHopM) add(`${p.id} → ${l.to} is ${Math.round(d)} m; every hop must be ${maxHopM} m or less.`);
    }
  }
  // Routes through a place that is not a candidate have no coordinates; that is reported above.
  const measurable = goodRoutes.filter((route) => route.every((id) => loc(id)));
  if (measurable.length) {
    let longest = { route: measurable[0], m: -1 };
    for (const route of measurable) {
      const m = routeLengthM(opts.center, route.map((id) => loc(id)!));
      if (m > longest.m) longest = { route, m };
    }
    const minutes = walkMinutes(longest.m, n);
    if (minutes > opts.minutes) {
      add(`The longest route (${arrow(longest.route)}) is ${Math.round(longest.m)} m with ${n} stops, about ${Math.round(minutes)} min; a ${opts.minutes}-min quest must fit in ${opts.minutes} min, so pick closer places.`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return buildQuest(w, facts, candidateById, opts, n);
}

/** Centre → first stop, then stop → stop, in metres. */
export function routeLengthM(center: LatLng, stops: LatLng[]): number {
  let total = 0;
  let from = center;
  for (const s of stops) {
    total += distanceM(from, s);
    from = s;
  }
  return total;
}

function checkFork(id: string, links: WriterLink[], stop: number, n: number, add: (e: string) => void) {
  const where = `${id} is a fork (stop ${stop} of ${n})`;
  if (links.length < 2 || links.length > 3) {
    add(`${where} but has ${links.length} link(s); a fork needs 2–3 links to different places, each with a different cue.`);
  }
  const tos = new Set<string>();
  for (const l of links) {
    if (tos.has(l.to)) add(`${where} but two links go to ${l.to}; each link must go to a different place.`);
    tos.add(l.to);
  }
  const cues = new Set<string>();
  for (const l of links) {
    if (!l.cue) {
      add(`${id} → ${l.to} has no cue; every fork link needs one of: ${CUES.join(", ")}.`);
      continue;
    }
    if (!CueSchema.safeParse(l.cue).success) {
      add(`${id} → ${l.to} uses the cue "${l.cue}", which is not in the cue list (${CUES.join(", ")}).`);
    }
    if (cues.has(l.cue)) add(`${where} but two links use the cue ${l.cue}; give each link a different cue.`);
    cues.add(l.cue);
  }
}

function checkResearchData(facts: Fact[], candidates: Candidate[]): string[] {
  const errors: string[] = [];
  const f = FactSchema.array().safeParse(facts);
  if (!f.success) errors.push(...zodErrors("facts", f.error));
  const c = CandidateSchema.array().safeParse(candidates);
  if (!c.success) errors.push(...zodErrors("candidates", c.error));
  for (const [what, ids] of [["fact", facts.map((x) => x.id)], ["candidate", candidates.map((x) => x.id)]] as const) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) errors.push(`research data: ${what} ID ${dupes[0]} is used twice; IDs must be unique.`);
  }
  const candidateIds = new Set(candidates.map((x) => x.id));
  for (const fact of facts) {
    if (fact.placeId !== undefined && !candidateIds.has(fact.placeId)) {
      errors.push(`research data: fact ${fact.id} has placeId ${fact.placeId}, which is not a candidate.`);
    }
  }
  return errors;
}

function zodErrors(what: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${what}${i.path.length ? ` at ${i.path.join(".")}` : ""}: ${i.message}`);
}

function buildQuest(
  w: WriterOutput,
  facts: Fact[],
  candidateById: Map<string, Candidate>,
  opts: ValidateOptions,
  n: StopsPerRun,
): ValidateResult {
  const cited = new Set<string>([
    ...w.mystery.factIds,
    ...w.finale.factIds,
    ...w.places.flatMap((p) => [...p.reveal.factIds, ...p.links.flatMap((l) => l.factIds)]),
  ]);
  // Lines that cite nothing (briefing, clue, look line, hint) may still state a number from a
  // fact. Keep that fact in the quest too, so the case file shows where every number came from.
  const keepFactFor = (text: string, pool: Fact[]) => {
    for (const num of numberTokens(text.replace(/\b[FP]\d+\b/g, ""))) {
      const backing = pool.filter((f) => numbersIn(f.text).includes(num.value));
      if (backing.length && !backing.some((f) => cited.has(f.id))) cited.add(backing[0].id);
    }
  };
  keepFactFor(w.briefing, facts);
  for (const p of w.places) {
    const own = facts.filter((f) => f.placeId === p.id);
    for (const text of [p.clue, p.look, p.hint]) keepFactFor(text, own);
  }
  const places: Place[] = w.places.map((p) => {
    const c = candidateById.get(p.id)!;
    const fork = p.links.length > 1;
    return {
      id: p.id,
      name: c.name,
      location: c.location,
      sourceUrl: c.sourceUrl,
      ...(c.gated !== undefined && { gated: c.gated }),
      ...(c.openNow !== undefined && { openNow: c.openNow }),
      clue: { text: p.clue },
      look: { text: p.look },
      hint: { text: p.hint },
      reveal: { text: p.reveal.text, factIds: p.reveal.factIds },
      // Only fork links carry a cue; a cue on the single link before the answer is dropped.
      links: p.links.map(
        (l): Link => ({
          to: l.to,
          ...(fork && { cue: l.cue as Cue }),
          reason: l.reason,
          factIds: l.factIds,
        }),
      ),
    };
  });
  const validation: ValidationRecord = opts.firstTryErrors?.length
    ? { firstTryOk: false, firstTryErrors: opts.firstTryErrors, repaired: true }
    : { firstTryOk: true, firstTryErrors: [], repaired: false };

  const quest = QuestSchema.safeParse({
    lang: opts.lang ?? "en",
    minutes: opts.minutes,
    center: opts.center,
    title: w.title,
    mystery: w.mystery,
    briefing: { text: w.briefing },
    facts: facts.filter((f) => cited.has(f.id)),
    places,
    startPlaceId: w.startPlaceId,
    answerPlaceId: w.answerPlaceId,
    stopsPerRun: n,
    finale: w.finale,
    validation,
    status: "ready",
  } satisfies Quest);
  if (!quest.success) return { ok: false, errors: zodErrors("quest", quest.error) };
  return { ok: true, quest: quest.data };
}
