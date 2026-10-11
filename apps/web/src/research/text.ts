/**
 * Small text helpers for the research step: name matching and fact sentences.
 */

/** Longest fact text the game keeps (one or two spoken sentences). */
export const MAX_FACT_CHARS = 300;

/** Lower case, no accents or Turkish dotted/dotless i, punctuation turned into spaces. */
export function fold(text: string): string {
  return text
    .toLocaleLowerCase("en")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * What kind of thing a name says the place is. Two places of different kinds are never merged,
 * even when they share the rest of their name (a mosque and the bath next to it).
 */
const KIND_WORDS: Record<string, string> = {
  mosque: "mosque",
  camii: "mosque",
  cami: "mosque",
  mescit: "mosque",
  mescidi: "mosque",
  church: "church",
  kilisesi: "church",
  kilise: "church",
  synagogue: "synagogue",
  sinagogu: "synagogue",
  havra: "synagogue",
  havrasi: "synagogue",
  fountain: "fountain",
  cesme: "fountain",
  cesmesi: "fountain",
  sebil: "fountain",
  sebili: "fountain",
  tower: "tower",
  kule: "tower",
  kulesi: "tower",
  hamam: "bath",
  hamami: "bath",
  bath: "bath",
  baths: "bath",
  museum: "museum",
  muzesi: "museum",
  muze: "museum",
  bridge: "bridge",
  koprusu: "bridge",
  kopru: "bridge",
  tomb: "tomb",
  turbe: "tomb",
  turbesi: "tomb",
  han: "inn",
  hani: "inn",
  library: "library",
  kutuphanesi: "library",
  school: "school",
  okulu: "school",
  lisesi: "school",
  pier: "pier",
  iskelesi: "pier",
  park: "park",
  parki: "park",
  garden: "garden",
  bahcesi: "garden",
  square: "square",
  meydani: "square",
  statue: "monument",
  monument: "monument",
  aniti: "monument",
  heykeli: "monument",
  memorial: "monument",
};

/** Words that say nothing about which place it is. */
const FILLER = new Set([
  "the", "of", "and", "st", "saint", "saints", "aziz", "ve", "istanbul", "old", "new", "historic",
  "historical", "former", "eski", "tarihi", "building", "binasi", "bina", "a", "an", "de", "la", "le",
  "ruins", "kalintilari", "kalintisi", "pasaj", "passage",
]);

/** The distinctive words of a name and the kind of place it names. */
export function nameParts(name: string): { tokens: Set<string>; kind: string | null } {
  const tokens = new Set<string>();
  let kind: string | null = null;
  for (const word of fold(name).split(" ")) {
    if (!word) continue;
    const k = KIND_WORDS[word];
    if (k) {
      kind ??= k;
      continue;
    }
    if (FILLER.has(word) || word.length < 3) continue;
    tokens.add(word);
  }
  return { tokens, kind };
}

/**
 * True when two names plausibly name the same place: the same folded name, or shared distinctive
 * words (half of the shorter name's) and no conflicting kind. "Galata Tower" ~ "Galata Kulesi";
 * "Kılıç Ali Paşa Mosque" ≁ "Kılıç Ali Paşa Hamamı".
 */
export function sameName(a: string, b: string): boolean {
  if (fold(a) === fold(b)) return true;
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (pa.kind && pb.kind && pa.kind !== pb.kind) return false;
  if (!pa.tokens.size || !pb.tokens.size) return false;
  let shared = 0;
  for (const t of pa.tokens) if (pb.tokens.has(t)) shared++;
  return shared > 0 && shared / Math.min(pa.tokens.size, pb.tokens.size) >= 0.5;
}

/** The kind of every word in `text` that names one ("camii" → mosque). */
function kindsIn(words: string[]): Set<string> {
  const kinds = new Set<string>();
  for (const w of words) if (KIND_WORDS[w]) kinds.add(KIND_WORDS[w]);
  return kinds;
}

/**
 * True when `text` is about the place `name`: it holds the name's distinctive words (both of
 * a two-word name, half of a longer one) and, when the name says what kind of place it is,
 * a word of that kind. "Galata was surrounded by walls" is not about "Galata Tower".
 */
export function aboutPlace(text: string, name: string): boolean {
  const { tokens, kind } = nameParts(name);
  const words = fold(text).split(" ");
  if (!tokens.size) return fold(text).includes(fold(name));
  const set = new Set(words);
  let hits = 0;
  for (const t of tokens) if (set.has(t)) hits++;
  const needed = tokens.size <= 2 ? tokens.size : Math.ceil(tokens.size / 2);
  if (hits < needed) return false;
  return !kind || kindsIn(words).has(kind);
}

/** Collapses white space and trims. */
export function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Abbreviations that end with a full stop but do not end a sentence.
const ABBREVIATIONS = /\b(?:St|Sts|Mt|Dr|Mr|Mrs|Ms|Prof|Jr|Sr|c|ca|approx|No|Nos|vs|etc|e\.g|i\.e|cf|Ave|Rd|Cad|Sk|Sok|Mah|Hz)\.$/i;

/**
 * Splits text into sentences. A full stop after an abbreviation ("St.") or a single initial,
 * or inside brackets ("(Turkish: 500. Yıl Vakfı)"), does not end a sentence.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  const parts = clean(text).split(/(?<=[.!?])\s+(?=["“(]?[A-ZÇĞİÖŞÜ0-9])/u);
  let carry = "";
  for (const part of parts) {
    const s = carry ? `${carry} ${part}` : part;
    const open = (s.match(/\(/g)?.length ?? 0) > (s.match(/\)/g)?.length ?? 0);
    if (open || ABBREVIATIONS.test(s) || /\b[A-Z]\.$/.test(s)) {
      carry = s;
      continue;
    }
    carry = "";
    if (s) out.push(s);
  }
  if (carry) out.push(carry);
  return out;
}

/**
 * Turns a search snippet into fact text: drops a leading date ("Oct 2, 2019 — ") and the
 * "..." of a cut snippet. A cut snippet keeps only its whole sentences; one with none is dropped
 * (a half sentence can say something the page does not).
 */
export function snippetText(snippet: string): string | null {
  let s = clean(snippet).replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4}\s*[—–-]\s*/, "");
  const cut = /(?:\.\.\.|…)$/.test(s);
  s = s.replace(/^(?:\.\.\.|…)\s*/, "").replace(/\s*(?:\.\.\.|…)$/, "");
  if (cut) {
    const whole = sentences(s).filter((x) => /[.!?]["”)]?$/.test(x));
    // The piece before the cut has no closing full stop, so it is dropped here.
    s = whole.join(" ");
  }
  s = clean(s);
  return s.length >= 20 ? s : null;
}

/** Fact texts from a longer text: whole sentences of at most MAX_FACT_CHARS, up to `max`. */
export function factSentences(text: string, max: number): string[] {
  return sentences(text)
    .filter((s) => s.length >= 20 && s.length <= MAX_FACT_CHARS)
    .slice(0, max);
}
