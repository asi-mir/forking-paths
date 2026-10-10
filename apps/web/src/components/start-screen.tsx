"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_NAME } from "@/lib/app";
import { getApi } from "@/play/api-browser";
import { preloadClips } from "@/play/audio";
import { ApiFailure, mockRequested, savedQuestParam } from "@/play/client";
import { type GpsFix, readPosition } from "@/play/photo";
import { newRun } from "@/play/run-state";
import { lastRunId, readRun, useHydrated, writeRun } from "@/play/run-store";
import { mockQuest } from "@/play/mock";
import { ArrowRightIcon, CheckIcon, DeskIcon, ForkMark, PinIcon } from "./icons";
import { ErrorNote, Label, PrimaryButton, Screen } from "./ui";

type Where =
  | { s: "idle" }
  | { s: "asking" }
  | { s: "ok"; fix: GpsFix }
  | { s: "denied" }
  | { s: "unavailable" };

type Minutes = 15 | 25;

export function StartScreen() {
  const router = useRouter();
  const hydrated = useHydrated();
  const mock = hydrated && mockRequested(window.location.search);
  // ?quest=<id> plays a saved quest (e.g. the Karaköy case) instead of finding one near the player.
  const savedQuestId = hydrated && !mock ? savedQuestParam(window.location.search) : null;
  const resumeId = hydrated ? lastRunId() : null;
  const resume = resumeId ? readRun(resumeId) : null;

  const [where, setWhere] = useState<Where>({ s: "idle" });
  const [minutes, setMinutes] = useState<Minutes>(15);
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locate = async () => {
    setWhere({ s: "asking" });
    const r = await readPosition(15_000, 60_000);
    setWhere(r.ok ? { s: "ok", fix: r.fix } : { s: r.reason === "denied" ? "denied" : "unavailable" });
  };

  // If location was allowed before, read it straight away; if it was blocked, say so.
  useEffect(() => {
    let live = true;
    navigator.permissions
      ?.query({ name: "geolocation" })
      .then((p) => {
        if (!live) return;
        if (p.state === "granted") void locate();
        else if (p.state === "denied") setWhere({ s: "denied" });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const located = where.s === "ok";
  const canStart = (located || mock) && log === null;

  const start = async () => {
    setError(null);
    const lines: string[] = [];
    const say = (line: string, replaceLast = false) => {
      if (replaceLast) lines.pop();
      lines.push(line);
      setLog([...lines]);
    };
    try {
      const api = getApi(mock);
      const center = where.s === "ok" ? where.fix : mockQuest(minutes).center;
      let quest: { questId: string };
      if (savedQuestId) {
        quest = { questId: savedQuestId };
        say("Opening the saved case.");
      } else {
        say("Looking for places and facts near you…");
        const made = await api.createQuest({ lat: center.lat, lng: center.lng, minutes, lang: "en" });
        say(
          made.overCap
            ? "Today's limit for new cases is reached: here is the nearest saved case."
            : made.reused
              ? "Found a case already written near here."
              : "The case is written.",
          true,
        );
        quest = made;
      }
      say("Getting the narrator ready…");
      const run = await api.startRun({ questId: quest.questId });
      say(run.voice ? "The narrator is ready." : "Voice is off today: every line shows as text.", true);
      if (run.preload.length > 0) {
        say(`Loading audio 0/${run.preload.length}`);
        await preloadClips(run.preload, (done, total) => say(`Loading audio ${done}/${total}`, true));
      }
      writeRun(newRun(run, api.mock, Date.now()));
      router.push(`/play/${encodeURIComponent(run.runId)}`);
    } catch (err) {
      setLog(null);
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  };

  return (
    <Screen
      top={
        <>
          <span className="flex items-center gap-2 text-ink">
            <ForkMark size={24} />
            <span className="label">A walking mystery</span>
          </span>
          {mock ? <span className="label rounded-sm border border-ink/30 px-1.5 py-0.5">Mock API</span> : <span className="label">EN</span>}
        </>
      }
      actions={
        <>
          <PrimaryButton onClick={start} disabled={!canStart} testId="start" icon={<ArrowRightIcon size={20} />}>
            {log ? "Starting…" : "Start the walk"}
          </PrimaryButton>
          <p className="text-center text-[13px] text-muted">Stay on the pavement, daylight only.</p>
        </>
      }
    >
      <section className="pt-6">
        <h1 className="narration text-[48px] font-[560] leading-[0.98] tracking-[-0.02em]">{APP_NAME}</h1>
        <p className="narration mt-3 text-[20px] italic leading-[1.35] text-ink">
          A voice mystery about the real streets around you.
        </p>
        <p className="mt-3 text-[15.5px] leading-[1.55] text-muted">
          Every fact the narrator tells you comes with its link. At each fork, the detail you photograph picks
          where you walk next. Every route ends at the same answer.
        </p>
      </section>

      {resume && !resume.finishedAt && log === null ? (
        <Link
          href={`/play/${encodeURIComponent(resume.runId)}`}
          className="mt-6 flex min-h-14 items-center justify-between rounded-[10px] border-[1.5px] border-ink/25 bg-card px-4 text-[15px] font-medium"
        >
          <span>
            <span className="label block">Walk in progress</span>
            {resume.start.title}
          </span>
          <ArrowRightIcon size={18} />
        </Link>
      ) : null}

      <section className="mt-6 rounded-[12px] border border-rule bg-card px-4 shadow-[0_1px_0_rgb(28_26_23/0.06)]">
        <Row n="01" title="Where you are">
          {where.s === "ok" ? (
            <p className="flex min-h-12 items-center gap-2 text-[15px]" data-testid="located">
              <CheckIcon size={18} />
              Located, to about {where.fix.accuracy} m
            </p>
          ) : where.s === "denied" || where.s === "unavailable" ? (
            <>
            <p className="text-[15px] leading-snug" data-testid="location-denied">
              {where.s === "denied"
                ? "Location is blocked for this site, so the walk cannot find your streets."
                : "Your phone could not find its position."}{" "}
              {where.s === "unavailable" ? (
                <button type="button" className="font-medium text-link underline underline-offset-2" onClick={locate}>
                  Try again
                </button>
              ) : null}
            </p>
            <DeskDemoLink strong />
            </>
          ) : (
            <button
              type="button"
              onClick={locate}
              disabled={where.s === "asking"}
              data-testid="locate"
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-ink/30 text-[16px] font-medium active:bg-ink/5 disabled:opacity-60"
            >
              <PinIcon size={18} />
              {where.s === "asking" ? "Finding you…" : "Allow location"}
            </button>
          )}
        </Row>
        <Row n="02" title="How long">
          <div role="radiogroup" aria-label="Walk length" className="grid grid-cols-2 gap-2">
            {([15, 25] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={minutes === m}
                onClick={() => setMinutes(m)}
                data-testid={`minutes-${m}`}
                className={`flex min-h-14 flex-col items-center justify-center rounded-[10px] border-[1.5px] ${
                  minutes === m ? "border-ink bg-ink text-paper" : "border-ink/25 text-ink"
                }`}
              >
                <span className="text-[17px] font-semibold">{m} min</span>
                <span className={`font-mono text-[11px] ${minutes === m ? "text-paper/75" : "text-muted"}`}>
                  {m === 15 ? "3 stops · 1 fork" : "4 stops · 2 forks"}
                </span>
              </button>
            ))}
          </div>
        </Row>
        <Row n="03" title="Language" last>
          <div className="flex min-h-9 items-center justify-between text-[15px]">
            <span className="font-medium">English</span>
            <span className="font-mono text-[11px] text-muted">Turkish later</span>
          </div>
        </Row>
      </section>

      {error ? (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {log ? (
        <ol className="mt-5 space-y-1 font-mono text-[13px] leading-relaxed text-ink" aria-live="polite" data-testid="start-log">
          {log.map((l, i) => (
            <li key={i} className="rise flex gap-2">
              <span className="text-muted">{String(i + 1).padStart(2, "0")}</span>
              {l}
            </li>
          ))}
        </ol>
      ) : null}

      {where.s === "denied" || where.s === "unavailable" ? null : <DeskDemoLink strong={false} />}
    </Screen>
  );
}

function Row({ n, title, children, last }: { n: string; title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`py-3.5 ${last ? "" : "border-b-[1.5px] border-dashed border-rule"}`}>
      <Label className="mb-2.5">
        <span className="text-ink">{n}</span>&nbsp;&nbsp;{title}
      </Label>
      {children}
    </div>
  );
}

function DeskDemoLink({ strong }: { strong: boolean }) {
  return (
    <Link
      href="/demo"
      data-testid="desk-demo"
      className={`flex min-h-14 items-center gap-3 rounded-[10px] ${
        strong ? "mt-3 border-[1.5px] border-link bg-paper px-4 py-3 text-link" : "mt-5 px-1 text-link"
      }`}
    >
      <DeskIcon size={22} />
      <span className="flex-1">
        <span className="block text-[16px] font-semibold underline decoration-link/40 underline-offset-[3px]">
          Try it from your desk
        </span>
        <span className="block text-[13px] text-muted">A saved case with sample photos. No walking, no location.</span>
      </span>
      <ArrowRightIcon size={18} />
    </Link>
  );
}
