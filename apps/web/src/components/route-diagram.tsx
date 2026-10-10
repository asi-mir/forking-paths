import type { CaseFile } from "@/quest/api";

/**
 * The walk as a small diagram: the path taken solid, each road not taken dashed, and every
 * route meeting at the answer. Stops are numbered; roads not taken are lettered (the list
 * under the diagram names them).
 */

const W = 350;
const H = 156;
const MID = 68;
const PAD = 26;
const OFFSET = 46;

export type DiagramLetter = { at: string; to: string; letter: string };

/** Letters for the roads not taken, in walk order: a, b, c… */
export function lettersFor(notTaken: CaseFile["notTaken"]): DiagramLetter[] {
  const out: DiagramLetter[] = [];
  for (const fork of notTaken) for (const alt of fork.notTaken) out.push({ at: fork.at, to: alt.to, letter: String.fromCharCode(97 + out.length) });
  return out;
}

export function RouteDiagram({ caseFile }: { caseFile: CaseFile }) {
  const stops = caseFile.route;
  const n = Math.max(stops.length, 2);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (n - 1);
  const answerX = x(stops.length - 1);
  const letters = lettersFor(caseFile.notTaken);

  const alts = caseFile.notTaken.flatMap((fork, forkIndex) => {
    const i = stops.findIndex((s) => s.placeId === fork.at);
    if (i < 0 || i >= stops.length - 1) return [];
    const midX = (x(i) + x(i + 1)) / 2;
    return fork.notTaken.map((alt, k) => {
      const side = (forkIndex + k) % 2 === 0 ? -1 : 1; // above, then below
      return {
        key: `${fork.at}-${alt.to}`,
        from: x(i),
        ax: midX,
        ay: MID + side * OFFSET,
        letter: letters.find((l) => l.at === fork.at && l.to === alt.to)?.letter ?? "?",
      };
    });
  });

  const height = alts.some((a) => a.ay > MID) ? H : MID + 50; // no branch below: no empty band

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Route: ${stops.map((s) => s.name).join(", then ")}. ${letters.length} road${letters.length === 1 ? "" : "s"} not taken, all meeting at the answer.`}
      >
        {/* roads not taken: dashed, fork → alternative → answer */}
        {alts.map((a) => (
          <g key={a.key} stroke="var(--muted)" strokeWidth="1.8" fill="none" strokeDasharray="4 5" strokeLinecap="round">
            <path d={`M ${a.from} ${MID} C ${a.from + 18} ${MID}, ${a.ax - 26} ${a.ay}, ${a.ax} ${a.ay}`} />
            <path d={`M ${a.ax} ${a.ay} C ${a.ax + (answerX - a.ax) * 0.7} ${a.ay}, ${answerX - 22} ${MID}, ${answerX} ${MID}`} />
          </g>
        ))}
        {/* the path taken */}
        <path d={`M ${x(0)} ${MID} L ${answerX} ${MID}`} stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" />
        {alts.map((a) => (
          <g key={`n-${a.key}`}>
            <circle cx={a.ax} cy={a.ay} r="12" fill="var(--card)" stroke="var(--muted)" strokeWidth="1.6" strokeDasharray="3 3" />
            <text x={a.ax} y={a.ay + 4.5} textAnchor="middle" fontFamily="var(--font-plex-mono)" fontSize="13" fill="var(--muted)">
              {a.letter}
            </text>
          </g>
        ))}
        {stops.map((s, i) => {
          const last = i === stops.length - 1;
          return (
            <g key={s.placeId}>
              {last ? <circle cx={x(i)} cy={MID} r="19" fill="none" stroke="var(--stamp)" strokeWidth="2.2" /> : null}
              <circle
                cx={x(i)}
                cy={MID}
                r="13"
                fill={s.status === "skipped" ? "var(--card)" : "var(--ink)"}
                stroke="var(--ink)"
                strokeWidth="2"
              />
              <text
                x={x(i)}
                y={MID + 4.5}
                textAnchor="middle"
                fontFamily="var(--font-plex-mono)"
                fontSize="12.5"
                fontWeight="600"
                fill={s.status === "skipped" ? "var(--ink)" : "var(--card)"}
              >
                {i + 1}
              </text>
            </g>
          );
        })}
        <text x={answerX} y={MID + 40} textAnchor="middle" fontFamily="var(--font-plex-mono)" fontSize="12" letterSpacing="1" fill="var(--stamp)">
          ANSWER
        </text>
        <text x={x(0)} y={MID + 40} textAnchor="middle" fontFamily="var(--font-plex-mono)" fontSize="12" letterSpacing="1" fill="var(--muted)">
          START
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-2">
          <svg width="26" height="6" aria-hidden>
            <path d="M1 3h24" stroke="var(--ink)" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          the path you took
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="26" height="6" aria-hidden>
            <path d="M1 3h24" stroke="var(--muted)" strokeWidth="1.8" strokeDasharray="4 5" strokeLinecap="round" />
          </svg>
          the road not taken
        </span>
      </figcaption>
    </figure>
  );
}
