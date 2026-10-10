/**
 * Small helpers shared by the eval scripts (`scripts/eval-*.ts`): seeded sampling, percentiles
 * and markdown tables. Pure, so the numbers they print can be reproduced and unit-tested.
 */

/** A seeded pseudo-random generator (mulberry32): the same seed gives the same sample. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy (Fisher–Yates with the seeded generator). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Up to `n` items picked at random with `seed`, kept in their original order. */
export function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  if (n >= items.length) return [...items];
  const picked = new Set(shuffled(items.map((_, i) => i), seed).slice(0, Math.max(0, n)));
  return items.filter((_, i) => picked.has(i));
}

/**
 * Up to `n` items, spread over groups: each group gets its share (in the order given) before any
 * group gets a second turn, so a small group (finales, bridges) is not crowded out by a big one.
 */
export function stratifiedSample<T>(items: readonly T[], groupOf: (item: T) => string, n: number, seed: number): T[] {
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), i]));
  const queues = [...groups.values()].map((list, g) => shuffled(list, seed + g));
  const picked = new Set<number>();
  const want = Math.min(Math.max(0, n), items.length);
  while (picked.size < want) {
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined && picked.size < want) picked.add(next);
    }
  }
  return items.filter((_, i) => picked.has(i));
}

/** The p-th percentile (nearest rank) of `values`; NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** "12/30 (40 %)", or "0/0" when there is nothing to count. */
export function ratio(ok: number, n: number): string {
  return n ? `${ok}/${n} (${Math.round((100 * ok) / n)} %)` : "0/0";
}

/** "75 %", or "-" when there is nothing to count. */
export function pct(ok: number, n: number): string {
  return n ? `${Math.round((100 * ok) / n)} %` : "-";
}

/** A markdown table cell: one line, no pipe that would split the cell. */
export function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value).replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

/** A markdown table. */
export function mdTable(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** Counts of each key, most common first (ties: alphabetical). */
export function tally(keys: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
