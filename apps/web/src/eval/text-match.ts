import { fold, sentences } from "@/research/text";

/**
 * Text matching for the fact check (page → fact): does the page a fact links to still say it?
 * Code finds the verbatim cases and the best passage; a model or a person checks the rest.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/** Decodes the common named and all numeric HTML entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The readable text of an HTML page: no scripts, styles or tags; blocks become lines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Words that carry no fact. */
const STOP = new Set(
  "the a an of and or in on at to for by with from as is was were are be been its it this that which who whom whose has had have also into than then there their his her they them one two".split(
    " ",
  ),
);

/** The words of a text that carry its content (folded, no stop words, digits kept). */
export function contentWords(text: string): string[] {
  return fold(text)
    .split(" ")
    .filter((w) => w && (/\d/.test(w) || (w.length >= 3 && !STOP.has(w))));
}

/** Digit groups in a text ("1732", "15th" → "15"). */
export function numbersOf(text: string): string[] {
  return [...new Set(text.match(/\d+/g) ?? [])];
}

export type FactMatch = {
  /** The page holds the fact word for word (after folding case, accents and punctuation). */
  verbatim: boolean;
  /** Share of the fact's content words found in the best passage (0..1). */
  coverage: number;
  /** Numbers in the fact that the page does not contain at all. */
  missingNumbers: string[];
  /** The page passage (up to 3 sentences) that shares the most content words with the fact. */
  passage: string;
};

/** Text without (bracketed) or [bracketed] asides, nested ones included. */
export function withoutBrackets(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) out = out.replace(/\s*[([][^()[\]]*[)\]]/g, "");
  return out;
}

/**
 * Pieces of a fact that must each appear on the page: its sentences, split at "…" cuts. A piece
 * of 4 words or more counts, and so does any piece with a digit ("Rebuilt 1850."); short pieces
 * without one ("Yes.") are too common to tell anything and are left out.
 */
function pieces(fact: string): string[] {
  return fact
    .split(/\s*(?:\.\.\.|…)\s*/)
    .flatMap((p) => sentences(p))
    .map(fold)
    .filter((p) => p && (p.split(" ").length >= 4 || /\d/.test(p)));
}

/**
 * Checks a fact against a page's text. `verbatim` is true when the whole fact, or each of its
 * sentences, appears on the page (with or without the page's bracketed asides), and every number
 * in the fact is on the page. Otherwise `coverage` and `passage` tell a checker where to look.
 */
export function matchFact(fact: string, pageText: string): FactMatch {
  const page = ` ${fold(pageText)} `;
  // Search results often quote a page without its bracketed asides ("(English: …)", "(27 BC–AD 14)").
  const unbracketed = ` ${fold(withoutBrackets(pageText))} `;
  const whole = fold(fact);
  const parts = pieces(fact);
  const holds = (p: string) => page.includes(` ${p} `) || unbracketed.includes(` ${p} `);
  const pageWords = new Set(page.split(" "));
  const missingNumbers = numbersOf(fact).filter((n) => !pageWords.has(n) && !page.includes(` ${n}`));
  // A fact with a number the page lacks is never word for word, whatever its sentences match.
  const verbatim = missingNumbers.length === 0 && ((!!whole && holds(whole)) || (parts.length > 0 && parts.every(holds)));

  const want = new Set(contentWords(fact));
  const lines = pageText.split(/\n+/).flatMap((l) => sentences(l));
  let best = { score: -1, passage: "" };
  for (let i = 0; i < lines.length; i++) {
    const passage = lines.slice(i, i + 3).join(" ");
    const have = new Set(contentWords(passage));
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    const score = want.size ? hit / want.size : 0;
    if (score > best.score) best = { score, passage };
    if (score === 1) break;
  }
  return {
    verbatim,
    coverage: Math.max(0, Math.round(best.score * 100) / 100),
    missingNumbers,
    passage: best.passage.slice(0, 1200),
  };
}
