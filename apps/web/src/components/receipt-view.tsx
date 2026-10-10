import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/app";
import type { Receipt } from "@/quest/api";
import { SCORE_RULES, formatDuration, scoreRun, screenOnShareOf } from "@/play/receipt";

/** The screen-time receipt, printed like a thermal till receipt. */
export function ReceiptView({
  runId,
  receipt,
  stopsFound,
  stopsTotal,
  serverScore,
  startedAt,
  finishedAt,
  saved,
}: {
  runId: string;
  receipt: Receipt;
  stopsFound: number;
  stopsTotal: number;
  serverScore: number | null;
  startedAt: number;
  finishedAt: number;
  saved: boolean;
}) {
  const share = screenOnShareOf(receipt);
  const score = scoreRun({ stopsFound, receipt });
  // Round once, so the two parts always add up to the walk on the printed receipt.
  const totalS = Math.round((receipt.screenOnMs + receipt.pocketMs) / 1000);
  const onS = Math.min(totalS, Math.round(receipt.screenOnMs / 1000));
  const total = totalS * 1000;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const when = new Date(finishedAt);
  const date = when.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const time = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className="receipt-edge mx-auto w-full max-w-[330px] bg-receipt px-5 pt-6 font-mono text-[13px] leading-[1.65] text-ink shadow-[0_3px_14px_rgb(28_26_23/0.14)]"
      data-testid="receipt"
    >
      <p className="text-center text-[13px] font-semibold tracking-[0.2em]">{APP_NAME.toUpperCase()}</p>
      <p className="text-center text-[11px] tracking-[0.14em] text-muted">SCREEN-TIME RECEIPT</p>
      <Rule />
      <Row left={`RUN ${runId.slice(-6).toUpperCase()}`} right={date} small />
      <Row left={`${time(startedAt)} → ${time(finishedAt)}`} right={`${stopsFound}/${stopsTotal} STOPS`} small />
      <Rule />
      <Row left="WALK" right={formatDuration(total)} />
      <Row left="SCREEN ON" right={<span data-testid="screen-on">{formatDuration(onS * 1000)} · {pct(share)}</span>} />
      <Row left="IN POCKET" right={<span data-testid="pocket">{formatDuration((totalS - onS) * 1000)} · {pct(1 - share)}</span>} />
      <Row left="PEEKS" right={<span data-testid="peeks">{receipt.peeks}</span>} />
      <Bar share={share} />
      <Rule />
      <Row left={`STOPS ${stopsFound} × ${SCORE_RULES.perStop}`} right={score.stops} />
      <Row left={`PEEKS ${receipt.peeks} × −${SCORE_RULES.perPeek}`} right={score.peeks === 0 ? "0" : `−${Math.abs(score.peeks)}`} />
      <Row left="LOW SCREEN BONUS" right={score.bonus > 0 ? `+${score.bonus}` : "0"} />
      <Rule />
      <div className="flex items-baseline justify-between text-[17px] font-semibold">
        <span>SCORE</span>
        <span data-testid="score">{serverScore ?? score.total}</span>
      </div>
      <Rule />
      <p className="text-center text-[11px] leading-snug text-muted">
        A peek is an unlock on the way to a stop without &ldquo;I&apos;m here&rdquo; within 20 s, or a replayed clue (one per
        unlock).
        {saved ? null : " Not saved to the server: no connection at the end."}
      </p>
      <p className="mt-2 text-center text-[11px] tracking-[0.2em] text-muted">* THANK YOU FOR WALKING *</p>
    </div>
  );
}

function Rule() {
  return <hr className="dashed-rule my-2.5 !border-ink/35" />;
}

function Row({ left, right, small }: { left: ReactNode; right: ReactNode; small?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${small ? "text-[11.5px] text-muted" : ""}`}>
      <span>{left}</span>
      <span className="text-right tabular-nums">{right}</span>
    </div>
  );
}

/** Screen-on share as a printed bar: solid for screen on, dotted for the pocket. */
function Bar({ share }: { share: number }) {
  return (
    <div aria-hidden className="mt-1.5 flex h-3 w-full overflow-hidden">
      <span className="block h-full bg-ink" style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
      <span
        className="block h-full flex-1"
        style={{ backgroundImage: "radial-gradient(var(--muted) 0.9px, transparent 1px)", backgroundSize: "4px 4px" }}
      />
    </div>
  );
}
