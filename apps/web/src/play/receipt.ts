import type { Receipt } from "@/quest/api";

/**
 * Pocket mode and the screen-time receipt. Pure: no DOM, no clock. The phone records a
 * timeline of events; these functions turn it into the receipt and the score. The server
 * (finish route) can use `scoreRun` too, so the phone and the server agree on the score.
 *
 * Rules:
 * - Screen-on time = time the page was visible; pocket time = time it was hidden.
 * - A peek = the page becomes visible while the player walks to a stop (after "Lock your
 *   phone. Go.", before "I'm here" or the photo) and neither follows within 20 s.
 * - Replaying a clue while walking counts as a peek.
 * - One unlock is at most one peek: an unlock followed by a replay is one peek, not two.
 */

export type TimelineEvent =
  | { t: number; e: "visible" } // the page became visible (also the first event of a run)
  | { t: number; e: "hidden" } // the page was hidden: phone locked, app switched
  | { t: number; e: "walk" } // pocket mode began: walking to a stop
  | { t: number; e: "arrive" } // the player tapped "I'm here" (the walk to this stop is over)
  | { t: number; e: "photo" } // the player opened the camera at a stop
  | { t: number; e: "replay" } // the player replayed the clue while walking
  | { t: number; e: "end" }; // the walk is over (the case file opened)

export type TimelineKind = TimelineEvent["e"];

/** A visible page counts as a peek unless "I'm here" or a photo follows within this window. */
export const PEEK_GRACE_MS = 20_000;

export type ReceiptSummary = Receipt & {
  totalMs: number; // screenOnMs + pocketMs
  screenOnShare: number; // 0..1; 1 when no time has passed
  pendingPeek: boolean; // the page is visible while walking and the 20 s window is still open
};

/**
 * Sum the timeline up to `now` (or up to the "end" event, whichever comes first).
 * Events are processed in time order; repeated states ("visible" twice) are ignored.
 */
export function summarize(events: readonly TimelineEvent[], now: number): ReceiptSummary {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const endAt = sorted.find((ev) => ev.e === "end")?.t;
  const stop = Math.max(endAt ?? now, sorted[0]?.t ?? now);
  const arrivals = sorted.filter((ev) => ev.e === "arrive" || ev.e === "photo").map((ev) => ev.t);

  let screenOnMs = 0;
  let pocketMs = 0;
  let peeks = 0;
  let pendingPeek = false;

  let visible: boolean | null = null; // unknown until the first visibility event
  let since = sorted[0]?.t ?? now;
  let walking = false;
  let spanCounted = false; // this visible stretch already counted as a peek (one unlock = one peek)

  const accrue = (until: number) => {
    const span = Math.max(0, Math.min(until, stop) - since);
    if (visible === true) screenOnMs += span;
    else if (visible === false) pocketMs += span;
    since = Math.min(until, stop);
  };

  for (const ev of sorted) {
    if (ev.t > stop) break;
    switch (ev.e) {
      case "visible":
      case "hidden": {
        const next = ev.e === "visible";
        if (visible === next) break;
        accrue(ev.t);
        const wasHidden = visible === false;
        visible = next;
        if (next) {
          spanCounted = false;
          pendingPeek = false;
        }
        if (next && wasHidden && walking) {
          const arrivedSoon = arrivals.some((p) => p >= ev.t && p <= ev.t + PEEK_GRACE_MS);
          if (arrivedSoon) break;
          if (endAt === undefined && now - ev.t < PEEK_GRACE_MS) pendingPeek = true;
          else {
            peeks += 1;
            spanCounted = true;
          }
        }
        break;
      }
      case "walk":
        if (visible === null) {
          visible = true;
          since = ev.t;
        }
        walking = true;
        break;
      case "arrive":
      case "photo":
        walking = false;
        pendingPeek = false;
        break;
      case "replay":
        if (walking && !spanCounted) {
          peeks += 1;
          spanCounted = true;
          pendingPeek = false;
        }
        break;
      case "end":
        walking = false;
        break;
    }
  }
  accrue(stop);

  const totalMs = screenOnMs + pocketMs;
  return {
    screenOnMs: Math.round(screenOnMs),
    pocketMs: Math.round(pocketMs),
    peeks,
    totalMs: Math.round(totalMs),
    screenOnShare: totalMs > 0 ? screenOnMs / totalMs : 1,
    pendingPeek,
  };
}

/** The receipt as the finish route expects it. */
export function toReceipt(summary: ReceiptSummary): Receipt {
  return { screenOnMs: summary.screenOnMs, pocketMs: summary.pocketMs, peeks: summary.peeks };
}

// ---------------------------------------------------------------------------
// Score

export const SCORE_RULES = {
  perStop: 100, // each stop passed (skipped stops earn nothing)
  perPeek: 10, // taken off for each peek
  /** Bonus for a low screen-on share, best tier first. */
  bonus: [
    { maxShare: 0.15, points: 50 },
    { maxShare: 0.3, points: 25 },
  ],
} as const;

export type ScoreBreakdown = {
  stops: number; // stopsFound × perStop
  peeks: number; // −(peeks × perPeek), as a negative number or 0
  bonus: number; // low screen-on bonus
  total: number; // never below 0
};

export function screenOnShareOf(receipt: Pick<Receipt, "screenOnMs" | "pocketMs">): number {
  const total = receipt.screenOnMs + receipt.pocketMs;
  return total > 0 ? receipt.screenOnMs / total : 1;
}

/** Points per stop, minus a penalty per peek, plus a bonus for a low screen-on share. */
export function scoreRun(input: { stopsFound: number; receipt: Receipt }): ScoreBreakdown {
  const share = screenOnShareOf(input.receipt);
  const stops = input.stopsFound * SCORE_RULES.perStop;
  const peeks = input.receipt.peeks === 0 ? 0 : -input.receipt.peeks * SCORE_RULES.perPeek;
  const bonus = SCORE_RULES.bonus.find((tier) => share <= tier.maxShare)?.points ?? 0;
  return { stops, peeks, bonus, total: Math.max(0, stops + peeks + bonus) };
}

/** "12:05" for 725 000 ms; hours roll into minutes ("75:00"). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
