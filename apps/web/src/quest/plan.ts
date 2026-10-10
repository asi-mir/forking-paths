import { distanceM, type LatLng, MIN_PER_STOP, WALK_M_PER_MIN } from "@/lib/geo";
import type { Candidate, StopsPerRun } from "./schema";
import { LIMITS, routeLengthM, stopsForMinutes } from "./validate";

/**
 * Route options for the writer: place sets that already meet the distance rules (every hop
 * ≤ 250 m, the start ≤ 250 m from the centre, the longest route fits the minutes). Gemma picks
 * one by its story and writes it; the validator still checks everything. Code measures the
 * distances because a language model cannot.
 *
 * Shapes (architecture.md, "Route shapes"):
 * - 3 stops: start (fork: A or B) → A or B (one link) → answer.
 * - 4 stops: start (fork: A or B) → A or B (each a fork: C or D) → C or D (one link) → answer.
 */

export type RouteOption = {
  stopsPerRun: StopsPerRun;
  start: string;
  /** The start's fork: two next places. */
  firstFork: [string, string];
  /** 4 stops only: the second fork's two places, linked from both places of the first fork. */
  secondFork?: [string, string];
  answer: string;
  /** The longest route from the centre, in metres. */
  longestM: number;
  /** Every place of the option, in route order. */
  places: string[];
};

export type PlanOptions = {
  maxHopM?: number;
  /** Centre → start (default `LIMITS.maxStartM`, the validator's limit). */
  maxStartM?: number;
  /** Options to return (best first). Default 6. */
  limit?: number;
  /** Fact count per candidate ID (more facts make a better answer place). */
  factCount?: Record<string, number>;
};

/** The longest walk (metres) a quest of `minutes` may have: 70 m/min, minus ~2 min per stop. */
export function maxRouteM(minutes: number, stops: number): number {
  return Math.max(0, (minutes - MIN_PER_STOP * stops) * WALK_M_PER_MIN);
}

/** Pairs of distinct items, each pair once. */
function pairs<T>(items: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
  return out;
}

export function routeOptions(
  candidates: Candidate[],
  center: LatLng,
  minutes: number,
  opts: PlanOptions = {},
): RouteOption[] {
  const n = stopsForMinutes(minutes);
  const maxHop = opts.maxHopM ?? LIMITS.maxHopM;
  const maxRoute = maxRouteM(minutes, n);
  const ids = candidates.map((c) => c.id);
  const loc = new Map(candidates.map((c) => [c.id, c.location]));
  const d = (a: string, b: string) => distanceM(loc.get(a)!, loc.get(b)!);
  const near = (a: string, b: string) => d(a, b) <= maxHop;
  const facts = (id: string) => opts.factCount?.[id] ?? 1;
  const longest = (routes: string[][]) =>
    Math.max(...routes.map((r) => routeLengthM(center, r.map((id) => loc.get(id)!))));

  const maxStart = opts.maxStartM ?? LIMITS.maxStartM;
  const starts = ids.filter((id) => distanceM(center, loc.get(id)!) <= maxStart);
  const found: (RouteOption & { score: number })[] = [];

  for (const s of starts) {
    const rest = ids.filter((id) => id !== s);
    for (const [a, b] of pairs(rest.filter((id) => near(s, id)))) {
      const after = rest.filter((id) => id !== a && id !== b);
      if (n === 3) {
        for (const x of after) {
          if (!near(a, x) || !near(b, x)) continue;
          const m = longest([[s, a, x], [s, b, x]]);
          if (m > maxRoute) continue;
          found.push({
            stopsPerRun: 3, start: s, firstFork: [a, b], answer: x, longestM: Math.round(m),
            places: [s, a, b, x],
            score: 2 * facts(x) + facts(a) + facts(b) + facts(s) - m / 150,
          });
        }
        continue;
      }
      const second = after.filter((id) => near(a, id) && near(b, id));
      for (const [c, e] of pairs(second)) {
        for (const x of after.filter((id) => id !== c && id !== e)) {
          if (!near(c, x) || !near(e, x)) continue;
          const m = longest([[s, a, c, x], [s, a, e, x], [s, b, c, x], [s, b, e, x]]);
          if (m > maxRoute) continue;
          found.push({
            stopsPerRun: 4, start: s, firstFork: [a, b], secondFork: [c, e], answer: x, longestM: Math.round(m),
            places: [s, a, b, c, e, x],
            score: 2 * facts(x) + facts(a) + facts(b) + facts(c) + facts(e) + facts(s) - m / 150,
          });
        }
      }
    }
  }

  // Best first; then keep variety: at most two options per answer place.
  found.sort((p, q) => q.score - p.score || p.longestM - q.longestM);
  const perAnswer = new Map<string, number>();
  const out: RouteOption[] = [];
  for (const option of found) {
    const o: RouteOption = { ...option };
    delete (o as Partial<typeof option>).score;
    const k = perAnswer.get(o.answer) ?? 0;
    if (k >= 2) continue;
    perAnswer.set(o.answer, k + 1);
    out.push(o);
    if (out.length >= (opts.limit ?? 6)) break;
  }
  return out;
}

/** Each option spelled out place by place, for the writer's prompt. */
export function describeOption(o: RouteOption, i: number): string {
  const [a, b] = o.firstFork;
  const lines =
    o.stopsPerRun === 3
      ? [
          `${o.start}: start, a fork with 2 links: to ${a} and to ${b} (a different cue each)`,
          `${a}: 1 link, to ${o.answer} (cue null)`,
          `${b}: 1 link, to ${o.answer} (cue null)`,
          `${o.answer}: the answer place, no links`,
        ]
      : [
          `${o.start}: start, a fork with 2 links: to ${a} and to ${b} (a different cue each)`,
          `${a}: a fork with 2 links: to ${o.secondFork![0]} and to ${o.secondFork![1]} (a different cue each)`,
          `${b}: a fork with 2 links: to ${o.secondFork![0]} and to ${o.secondFork![1]} (a different cue each)`,
          `${o.secondFork![0]}: 1 link, to ${o.answer} (cue null)`,
          `${o.secondFork![1]}: 1 link, to ${o.answer} (cue null)`,
          `${o.answer}: the answer place, no links`,
        ];
  return `Option ${i + 1} (longest route ${o.longestM} m; places ${o.places.join(", ")}):\n${lines.map((l) => `  - ${l}`).join("\n")}`;
}
