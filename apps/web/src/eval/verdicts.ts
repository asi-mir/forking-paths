import type { FactCheck, RevealCheck } from "./precheck";
import { percentile } from "./stats";
import type { FactMatch } from "./text-match";

/**
 * How the eval scripts turn checks into the numbers they report. Pure, so each headline number
 * can be unit tested: who decided a verdict, and how generations and photos are counted.
 */

export type Reviewer = "agent" | "owner";

// ---------------------------------------------------------------------------
// Fact check (page → fact)

export type FactReview = { verdict: "held" | "partly" | "missed"; by: Reviewer; note?: string };
export type FactVerdict = "held" | "partly" | "missed" | "not checkable" | "not checked";
export type FactDecider = "code (word for word)" | "gemma pre-check" | Reviewer | "-";

export type FactEvidence = {
  fetch: { ok: boolean };
  match: Pick<FactMatch, "verbatim"> | null;
  gemma: Pick<FactCheck, "verdict"> | { error: string } | null;
  review: FactReview | null;
};

/**
 * The verdict that counts for a fact, and who made it: the owner's review, then the agent's,
 * then code (word for word), then Gemma's pre-check. A fact whose page could not be read is
 * "not checkable"; one that was read but has no verdict yet is "not checked".
 */
export function decideFact(r: FactEvidence): { verdict: FactVerdict; decidedBy: FactDecider } {
  if (r.review?.by === "owner") return { verdict: r.review.verdict, decidedBy: "owner" };
  if (r.review?.by === "agent") return { verdict: r.review.verdict, decidedBy: "agent" };
  if (!r.fetch.ok) return { verdict: "not checkable", decidedBy: "-" };
  if (r.match?.verbatim) return { verdict: "held", decidedBy: "code (word for word)" };
  if (r.gemma && "verdict" in r.gemma) {
    const v = r.gemma.verdict === "holds" ? "held" : r.gemma.verdict === "partly" ? "partly" : "missed";
    return { verdict: v, decidedBy: "gemma pre-check" };
  }
  return { verdict: "not checked", decidedBy: "-" };
}

// ---------------------------------------------------------------------------
// Reveal check (fact → narration)

export type RevealVerdict = RevealCheck["verdict"];
export type RevealReview = { verdict: RevealVerdict; by: Reviewer; note?: string };

/** The verdict that counts for a line: a review (owner or agent) wins over Gemma's pre-check. */
export function decideReveal(
  review: RevealReview | null,
  gemma: Pick<RevealCheck, "verdict"> | { error: string } | null,
): { verdict: RevealVerdict | "not checked"; decidedBy: "gemma pre-check" | Reviewer | "-" } {
  if (review) return { verdict: review.verdict, decidedBy: review.by };
  if (gemma && "verdict" in gemma) return { verdict: gemma.verdict, decidedBy: "gemma pre-check" };
  return { verdict: "not checked", decidedBy: "-" };
}

// ---------------------------------------------------------------------------
// Validator first try

export type GenerationOutcome = {
  id: string;
  status: "ready" | "failed" | "no-draft";
  validation?: { firstTryOk: boolean; repaired: boolean } | null;
};

/**
 * Generations in three exclusive buckets, in this order: the first draft passed; the quest ended
 * ready after a repair; everything else with a draft failed. The three always add up to `drafted`.
 * `mismatch` names the generations whose status and validation disagree (a first draft that
 * passed but did not end ready; a quest that ended ready with no pass and no repair recorded),
 * so the report can list them.
 */
export function validatorSummary(gens: readonly GenerationOutcome[]) {
  const drafted = gens.filter((g) => g.validation);
  let firstTry = 0;
  let afterRepair = 0;
  let failed = 0;
  const mismatch: string[] = [];
  for (const g of drafted) {
    if (g.validation!.firstTryOk) {
      firstTry++;
      if (g.status !== "ready") mismatch.push(g.id);
    } else if (g.status === "ready" && g.validation!.repaired) afterRepair++;
    else {
      failed++;
      if (g.status === "ready") mismatch.push(g.id);
    }
  }
  return {
    generations: gens.length,
    drafted: drafted.length,
    firstTry,
    afterRepair,
    failed,
    noDraft: gens.length - drafted.length,
    /** Ids of the generations whose status and validation disagree. */
    mismatch,
  };
}

// ---------------------------------------------------------------------------
// Photo reader

export type ReaderOutcome = {
  offered: string[];
  expected: { plausible: boolean; cue: string | null };
  error: string | null;
  latencyMs: number;
  plausibleOk: boolean;
  cueOk: boolean;
  passOk: boolean;
};

/** One provider's photo-reader numbers. Errors count as misses; latency counts calls that answered. */
export function readerSummary(rows: readonly ReaderOutcome[]) {
  const ok = rows.filter((r) => !r.error);
  const pos = rows.filter((r) => r.expected.plausible);
  const offered = pos.filter((r) => r.expected.cue !== null);
  const none = pos.filter((r) => r.expected.cue === null);
  const neg = rows.filter((r) => !r.expected.plausible);
  const lat = ok.map((r) => r.latencyMs);
  return {
    photos: rows.length,
    errors: rows.length - ok.length,
    plausibleOk: rows.filter((r) => r.plausibleOk).length,
    cueOk: pos.filter((r) => r.cueOk).length,
    positives: pos.length,
    cueOffered: offered.length,
    cueOfferedOk: offered.filter((r) => r.cueOk).length,
    chance: offered.reduce((s, r) => s + 1 / Math.max(1, r.offered.length), 0),
    cueNone: none.length,
    cueNoneOk: none.filter((r) => r.cueOk).length,
    negatives: neg.length,
    negativesRefused: neg.filter((r) => r.passOk).length,
    positivesPassed: pos.filter((r) => r.passOk).length,
    passOk: rows.filter((r) => r.passOk).length,
    p50Ms: percentile(lat, 50),
    p95Ms: percentile(lat, 95),
  };
}
