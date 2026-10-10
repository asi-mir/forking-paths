"use client";

import Link from "next/link";
import { useState } from "react";
import type { CitedFact } from "@/quest/api";
import { CUE_TAG, roadNotTakenLine } from "@/play/labels";
import { deletePhotos } from "@/play/photo-store";
import { summarize, toReceipt } from "@/play/receipt";
import { useRun } from "@/play/run-store";
import { SampleCredit, sentSample } from "./desk";
import { ExternalIcon } from "./icons";
import { ReceiptView } from "./receipt-view";
import { RouteDiagram, lettersFor } from "./route-diagram";
import { useRunPhotos } from "./use-run-photos";
import { FactCard, Label, Screen, Snapshot, Stamp } from "./ui";

/** The case file: the answer, the route and the road not taken, photos, facts, receipt. */
export function CaseFileScreen({ runId }: { runId: string }) {
  const run = useRun(runId);
  const { photos, refresh } = useRunPhotos(runId);
  const [deleted, setDeleted] = useState(false);

  if (run === undefined) {
    return (
      <Screen>
        <p className="label m-auto">Opening the case file…</p>
      </Screen>
    );
  }
  if (!run?.end) {
    return (
      <Screen actions={<HomeLink />}>
        <div className="m-auto max-w-[320px] text-center">
          <Label className="mb-3">No case file here</Label>
          <p className="narration text-[24px] leading-snug">
            {run ? "This walk is not over yet." : "A case file lives on the phone that walked it."}
          </p>
          {run ? (
            <Link href={`/play/${encodeURIComponent(runId)}`} className="mt-5 inline-block font-medium text-link underline">
              Back to the walk
            </Link>
          ) : null}
        </div>
      </Screen>
    );
  }

  const cf = run.end.caseFile;
  const finishedAt = run.finishedAt ?? run.createdAt;
  const receipt = run.finish?.receipt ?? toReceipt(summarize(run.timeline, finishedAt));
  const stopsFound = run.finish?.stopsFound ?? cf.route.filter((r) => r.status === "passed").length;
  const factById = new Map(cf.facts.map((f) => [f.id, f]));
  const letters = lettersFor(cf.notTaken);
  const caseNo = runId.slice(-4).toUpperCase();
  const opened = new Date(run.createdAt);

  return (
    <Screen actions={run.desk ? <DeskAgainLink /> : <HomeLink />}>
      <article className="relative mt-5 rounded-[4px] border border-rule bg-card px-5 pb-8 pt-6 shadow-[0_2px_18px_rgb(28_26_23/0.12)]">
        {/* folder tab */}
        <span aria-hidden className="absolute -top-3.5 left-5 h-4 w-28 rounded-t-[6px] border border-b-0 border-rule bg-card" />
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 whitespace-nowrap">
            <p className="label">Case file {caseNo}</p>
            <p className="label mt-1">
              {opened.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </p>
            <p className="label mt-1">
              {cf.route.length} stops · {cf.notTaken.length} {cf.notTaken.length === 1 ? "fork" : "forks"}
            </p>
          </div>
          <Stamp tone="red" rotate={-10} className="mt-2 shrink-0 !text-[24px]">
            Solved
          </Stamp>
        </header>

        <h1 className="narration mt-6 text-[32px] font-[560] leading-[1.08]" data-testid="case-title">
          {run.start.title}
        </h1>

        <Section n="I" title="The question">
          <p className="narration text-[20px] italic leading-[1.35]">{cf.mystery.question}</p>
        </Section>
        <Section n="II" title="The answer">
          <p className="narration text-[21px] font-[560] leading-[1.3]">{cf.mystery.answer}</p>
        </Section>

        <Section n="III" title="Your route">
          <RouteDiagram caseFile={cf} />
          <ol className="mt-5 space-y-3" data-testid="route">
            {cf.route.map((step, i) => (
              <li key={step.placeId} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-semibold ${
                    step.status === "passed" ? "bg-ink text-card" : "border-2 border-ink text-ink"
                  }`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[16px] font-semibold leading-snug">
                    {step.name}
                    {step.status === "skipped" ? <span className="label ml-2">skipped</span> : null}
                  </p>
                  {step.observed ? (
                    <p className="mt-0.5 text-[14.5px] leading-snug text-muted">
                      You chose <span className="narration italic text-ink">{step.observed}</span>
                      {step.cue ? (
                        <>
                          {" "}
                          · <span className="font-mono text-[12px]">{CUE_TAG[step.cue]}</span>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Section>

        {cf.notTaken.length > 0 ? (
          <Section n="IV" title="The road not taken">
            <div className="space-y-4" data-testid="not-taken">
              {cf.notTaken.flatMap((fork) =>
                fork.notTaken.map((alt) => (
                  <div key={`${fork.at}-${alt.to}`} className="rounded-[8px] border-[1.5px] border-dashed border-ink/30 p-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-muted font-mono text-[12px] text-muted">
                        {letters.find((l) => l.at === fork.at && l.to === alt.to)?.letter}
                      </span>
                      <div className="min-w-0">
                        <p className="label mb-1">At {fork.atName}</p>
                        <p className="narration text-[18px] leading-snug">{roadNotTakenLine(alt.cue, alt.name)}</p>
                        <p className="mt-2 text-[14px] leading-snug text-muted">{alt.reason}</p>
                        <FactLinks facts={alt.factIds.flatMap((id) => factById.get(id) ?? [])} />
                      </div>
                    </div>
                  </div>
                )),
              )}
            </div>
          </Section>
        ) : null}

        <Section n={cf.notTaken.length > 0 ? "V" : "IV"} title="Your photos">
          {photos.length > 0 && !deleted ? (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 pt-2" data-testid="photos">
                {photos.map((p, i) => (
                  <Snapshot
                    key={p.placeId}
                    src={p.url}
                    rotate={i % 2 === 0 ? -2 : 1.5}
                    caption={
                      <>
                        {`${i + 1} · ${cf.route.find((r) => r.placeId === p.placeId)?.name ?? p.placeId}`}
                        {sentSample(run, p.placeId) ? <SampleCredit sample={sentSample(run, p.placeId)!} className="mt-1" /> : null}
                      </>
                    }
                  />
                ))}
              </div>
              <p className="mt-4 text-[13.5px] leading-snug text-muted">
                These stay on this phone. The server checked each photo and kept none.{" "}
                <button
                  type="button"
                  className="font-medium text-link underline underline-offset-2"
                  onClick={async () => {
                    await deletePhotos(runId);
                    setDeleted(true);
                    refresh();
                  }}
                >
                  Delete them
                </button>
              </p>
            </>
          ) : (
            <p className="text-[14px] text-muted">{deleted ? "Deleted from this phone." : "No photos on this phone."}</p>
          )}
        </Section>

        <Section n={cf.notTaken.length > 0 ? "VI" : "V"} title="Every fact in this case">
          <p className="-mt-1 mb-4 text-[14px] leading-snug text-muted">
            Each fact the narrator told you, with where it came from, the exact query and the link.
          </p>
          <div className="flex flex-col gap-3" data-testid="facts">
            {cf.facts.map((f) => (
              <FactCard key={f.id} fact={f} />
            ))}
          </div>
        </Section>
      </article>

      <section className="mt-10">
        <Label className="mb-4 text-center">Screen time</Label>
        <ReceiptView
          runId={runId}
          receipt={receipt}
          stopsFound={stopsFound}
          stopsTotal={cf.route.length}
          serverScore={run.finish?.score ?? null}
          startedAt={run.createdAt}
          finishedAt={finishedAt}
          saved={run.finish !== null}
          checkers={run.checkers ?? []}
        />
      </section>
    </Screen>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline gap-3 border-b-[1.5px] border-ink pb-1.5">
        <span className="font-mono text-[12px] text-muted">{n}.</span>
        <h2 className="label !text-[12px] !text-ink">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function FactLinks({ facts }: { facts: CitedFact[] }) {
  if (facts.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {facts.map((f) => (
        <li key={f.id}>
          <a
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1 font-mono text-[12px] text-link underline decoration-link/40 underline-offset-2"
          >
            {f.id} · {f.sourceTitle}
            <ExternalIcon size={13} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Desk demo: play the case again and pick the other detail at the fork. */
function DeskAgainLink() {
  return (
    <>
      <Link
        href="/demo"
        data-testid="desk-again"
        className="flex min-h-14 w-full items-center justify-center rounded-[10px] bg-stamp px-5 text-[17px] font-semibold text-stamp-ink"
      >
        Play again and pick the other detail
      </Link>
      <Link href="/demo/near" className="flex min-h-11 items-center justify-center text-[15px] font-medium text-link underline underline-offset-2">
        Generate a quest near me
      </Link>
    </>
  );
}

function HomeLink() {
  return (
    <Link
      href="/"
      className="flex min-h-14 w-full items-center justify-center rounded-[10px] bg-stamp px-5 text-[17px] font-semibold text-stamp-ink"
    >
      Start another walk
    </Link>
  );
}

