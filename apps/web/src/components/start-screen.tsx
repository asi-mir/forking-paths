"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_NAME } from "@/lib/app";
import { getApi } from "@/play/api-browser";
import { preloadClips } from "@/play/audio";
import { QUEST_DEADLINE_MS } from "@/quest/api";
import { ApiFailure, mockRequested, savedQuestParam } from "@/play/client";
import { distanceText } from "@/play/labels";
import { isDark } from "@/play/daylight";
import { type GpsFix, readPosition } from "@/play/photo";
import { MAX_USABLE_ACCURACY_M } from "@/quest/check";
import { newRun } from "@/play/run-state";
import { lastRunId, readRun, useHydrated, writeRun } from "@/play/run-store";
import { mockQuest } from "@/play/mock";
import { ArrowRightIcon, CheckIcon, DeskIcon, ForkMark, PinIcon } from "./icons";
import { ErrorNote, Label, PrimaryButton, Screen } from "./ui";

type Where =
  | { s: "idle" }
  | { s: "asking" }
  | { s: "ok"; fix: GpsFix }
  | { s: "coarse"; accuracy: number }
  | { s: "denied" }
  | { s: "unavailable" };

type Minutes = 15 | 25;

/** A saved case further than this (the server's reuse radius) is offered, never started unasked. */
const NEAR_ENOUGH_M = 500;

/** A saved case found over today's limit, waiting for the player to say yes. */
type Offer = { questId: string; distanceM: number };

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
  const [offer, setOffer] = useState<Offer | null>(null);

  /**
   * Reads the position. A coarse fix (Precise Location off, or a cell or Wi-Fi fallback) is
   * refused: a case written around it would start in the wrong streets.
   */
  const locate = async (): Promise<GpsFix | null> => {
    setWhere({ s: "asking" });
    const r = await readPosition(15_000, 60_000);
    if (!r.ok) {
      setWhere({ s: r.reason === "denied" ? "denied" : "unavailable" });
      return null;
    }
    if (r.fix.accuracy > MAX_USABLE_ACCURACY_M) {
      setWhere({ s: "coarse", accuracy: r.fix.accuracy });
      return null;
    }
    setWhere({ s: "ok", fix: r.fix });
    return r.fix;
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

  const dark = where.s === "ok" && !mock && isDark(where.fix.lat, where.fix.lng);
  // The main button stays live: with no fix yet, the tap asks for location first.
  const canStart = (mock || (where.s !== "denied" && where.s !== "asking")) && log === null;

  const start = async () => {
    setError(null);
    setOffer(null);
    let fix: GpsFix | null = where.s === "ok" ? where.fix : null;
    if (!fix && !mock) {
      fix = await locate();
      if (!fix) return;
    }
    const center = fix ?? mockQuest(minutes).center;
    const lines: string[] = [];
    const say = (line: string, replaceLast = false) => {
      if (replaceLast) lines.pop();
      lines.push(line);
      setLog([...lines]);
    };
    try {
      const api = getApi(mock);
      let quest: { questId: string };
      if (savedQuestId) {
        quest = { questId: savedQuestId };
        say("Opening the saved case.");
      } else {
        say("Looking for places and facts near you…");
        // A new case can take a few minutes to write: say so, so the wait does not look stuck.
        const slow = window.setTimeout(() => say(`Gemma is still writing the case. This can take up to ${Math.round(QUEST_DEADLINE_MS / 60_000)} minutes.`, true), 45_000);
        const made = await api
          .createQuest({ lat: center.lat, lng: center.lng, minutes, lang: "en" })
          .finally(() => window.clearTimeout(slow));
        if (made.overCap && made.distanceM !== undefined && made.distanceM > NEAR_ENOUGH_M) {
          // Too far to walk to unasked: show the offer and wait for a yes.
          setLog(null);
          setOffer({ questId: made.questId, distanceM: made.distanceM });
          return;
        }
        say(
          made.overCap
            ? `Today's limit for new cases is reached: here is the nearest saved case${
                made.distanceM !== undefined ? `, ${distanceText(made.distanceM)} away` : ""
              }.`
            : made.reused
              ? "Found a case already written near here."
              : "The case is written.",
          true,
        );
        quest = made;
      }
      await begin(quest.questId, say);
    } catch (err) {
      setLog(null);
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  };

  /** Starts the run of a quest and opens the walk. */
  const begin = async (questId: string, say: (line: string, replaceLast?: boolean) => void) => {
    const api = getApi(mock);
    say("Getting the narrator ready…");
    const run = await api.startRun({ questId });
    say(run.voice ? "The narrator is ready." : "Voice is off today: every line shows as text.", true);
    if (run.preload.length > 0) {
      say(`Loading audio 0/${run.preload.length}`);
      await preloadClips(run.preload, (done, total) => say(`Loading audio ${done}/${total}`, true));
    }
    writeRun(newRun(run, api.mock, Date.now()));
    router.push(`/play/${encodeURIComponent(run.runId)}`);
  };

  /** The player said yes to the far saved case. */
  const acceptOffer = async () => {
    if (!offer) return;
    const lines: string[] = [];
    const say = (line: string, replaceLast = false) => {
      if (replaceLast) lines.pop();
      lines.push(line);
      setLog([...lines]);
    };
    setError(null);
    try {
      say(`Opening the saved case, ${distanceText(offer.distanceM)} away.`);
      setOffer(null);
      await begin(offer.questId, say);
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
          {dark ? (
            <p className="rounded-[10px] border-[1.5px] border-stamp bg-card px-3 py-2 text-[14px] leading-snug text-ink" data-testid="dark-note">
              It is dark now. Walk in daylight, or try it from your desk.
            </p>
          ) : null}
          {offer ? null : (
            <PrimaryButton onClick={start} disabled={!canStart} testId="start" icon={<ArrowRightIcon size={20} />}>
              {log ? "Starting…" : where.s === "asking" ? "Finding you…" : "Start the walk"}
            </PrimaryButton>
          )}
          <p className="text-center text-[13px] text-muted">
            {where.s === "denied" ? "Location is blocked: try it from your desk instead." : "Stay on the pavement, daylight only."}
          </p>
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
          ) : where.s === "coarse" ? (
            <p className="text-[15px] leading-snug" data-testid="location-coarse">
              Your location is approximate (±{where.accuracy} m). Turn on Precise Location, or wait a moment and try
              again.{" "}
              <button type="button" className="font-medium text-link underline underline-offset-2" onClick={() => void locate()}>
                Try again
              </button>
            </p>
          ) : where.s === "denied" || where.s === "unavailable" ? (
            <>
            <p className="text-[15px] leading-snug" data-testid="location-denied">
              {where.s === "denied"
                ? "Location is blocked for this site, so the walk cannot find your streets."
                : "Your phone could not find its position."}{" "}
              {where.s === "unavailable" ? (
                <button type="button" className="font-medium text-link underline underline-offset-2" onClick={() => void locate()}>
                  Try again
                </button>
              ) : null}
            </p>
            <DeskDemoLink strong />
            <Link
              href="/demo/near"
              data-testid="pick-city"
              className="mt-2 flex min-h-12 items-center justify-center gap-2 text-[15px] font-medium text-link underline underline-offset-2"
            >
              <PinIcon size={16} />
              Or see a case in a city you pick
            </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void locate()}
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
          <div className="flex min-h-9 items-center text-[15px]">
            <span className="font-medium">English</span>
          </div>
        </Row>
      </section>

      {offer ? (
        <section className="mt-5 rounded-[12px] border-[1.5px] border-ink/25 bg-card px-4 py-4" data-testid="far-offer">
          <p className="text-[15px] leading-snug">
            Today&apos;s limit for new cases is reached. The nearest saved case starts {distanceText(offer.distanceM)} from
            here, so the first clue assumes you walk there first.
          </p>
          <button
            type="button"
            onClick={() => void acceptOffer()}
            data-testid="far-offer-accept"
            className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-ink text-[16px] font-medium text-paper"
          >
            Play the case {distanceText(offer.distanceM)} away
          </button>
          <DeskDemoLink strong />
        </section>
      ) : null}

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
