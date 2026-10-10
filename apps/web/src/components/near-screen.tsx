"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { API, type CreateQuestResponse, QUEST_DEADLINE_MS, type QuestView, type QuestViewLine } from "@/quest/api";
import { getApi } from "@/play/api-browser";
import { DESK_CITIES, type DeskCity } from "@/play/cities";
import { ApiFailure, fetchQuestLine, fetchQuestView } from "@/play/client";
import { CUE_TAG, distanceText } from "@/play/labels";
import { readPosition } from "@/play/photo";
import { StartLog, useDeskStart } from "./desk-demo-screen";
import { ArrowRightIcon, DeskIcon, ForkMark, PinIcon, PlayIcon, StopIcon } from "./icons";
import { ErrorNote, FactCard, Label, PrimaryButton, Screen } from "./ui";

type Where = { s: "idle" } | { s: "asking" } | { s: "denied" } | { s: "unavailable" };
type Made = { view: QuestView; made: CreateQuestResponse; place: string };

/** /demo/near: "Generate a quest near me", or in a city from the list when location is not available. */
export function NearScreen() {
  const [where, setWhere] = useState<Where>({ s: "idle" });
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const desk = useDeskStart();

  const generate = async (lat: number, lng: number, place: string) => {
    setError(null);
    setMade(null);
    const lines: string[] = [];
    const say = (line: string, replaceLast = false) => {
      if (replaceLast) lines.pop();
      lines.push(line);
      setLog([...lines]);
    };
    say(`Looking for places and facts ${place}…`);
    const slow = window.setTimeout(
      () => say(`Gemma is still writing the case. This can take up to ${Math.round(QUEST_DEADLINE_MS / 60_000)} minutes.`, true),
      45_000,
    );
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await getApi(false)
        .createQuest({ lat, lng, minutes: 15, lang: "en", ...(timeZone ? { timeZone } : {}) })
        .finally(() => window.clearTimeout(slow));
      say(
        res.overCap
          ? `Today's limit for new cases is reached: here is the nearest saved case${res.distanceM !== undefined ? `, ${distanceText(res.distanceM)} away` : ""}.`
          : res.reused
            ? `Found a case already written here${res.distanceM !== undefined ? `, ${distanceText(res.distanceM)} away` : ""}.`
            : "The case is written.",
        true,
      );
      const view = await fetchQuestView(res.questId);
      setMade({ view, made: res, place });
      setLog(null);
    } catch (err) {
      setLog(null);
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  };

  const locate = async () => {
    setWhere({ s: "asking" });
    const r = await readPosition(15_000, 60_000);
    if (!r.ok) {
      setWhere({ s: r.reason === "denied" ? "denied" : "unavailable" });
      return;
    }
    setWhere({ s: "idle" });
    await generate(r.fix.lat, r.fix.lng, "near you");
  };

  const busy = log !== null;

  if (made) {
    return (
      <QuestPreview
        made={made}
        onBack={() => setMade(null)}
        onPlay={() => void desk.start(made.view.questId)}
        startLog={desk.log}
        startError={desk.error}
      />
    );
  }

  return (
    <Screen top={<DeskTop />}>
      <section className="pt-6">
        <h1 className="narration text-[36px] font-[560] leading-[1.05] tracking-[-0.02em]">Generate a quest near me</h1>
        <p className="mt-3 text-[15.5px] leading-[1.55] text-muted">
          Gemma writes a 15-minute case from facts fetched around a point, each with its link. A case already saved
          within about 500 m is reused. New cases are capped per day.
        </p>
      </section>

      <section className="mt-6">
        <button
          type="button"
          onClick={() => void locate()}
          disabled={busy || where.s === "asking"}
          data-testid="near-locate"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-[10px] bg-stamp px-5 text-[17px] font-semibold text-stamp-ink disabled:opacity-50"
        >
          <PinIcon size={20} />
          {where.s === "asking" ? "Finding you…" : "Use my location"}
        </button>
        {where.s === "denied" || where.s === "unavailable" ? (
          <p className="mt-3 text-[14.5px] leading-snug" data-testid="near-denied">
            {where.s === "denied" ? "Location is blocked for this site." : "Your device could not find its position."} Pick a
            city instead.
          </p>
        ) : null}
      </section>

      <section className="mt-7">
        <Label className="mb-3">Or pick a city</Label>
        <ul className="flex flex-col gap-2" data-testid="city-picker">
          {DESK_CITIES.map((c) => (
            <li key={c.id}>
              <CityButton city={c} disabled={busy} onPick={() => void generate(c.lat, c.lng, `in ${c.name}`)} />
            </li>
          ))}
        </ul>
        <p className="mt-3 font-mono text-[11.5px] leading-snug text-muted">
          Tested: a case was generated there and passed the checks.
        </p>
      </section>

      {error ? (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {log ? <StartLog log={log} /> : null}
    </Screen>
  );
}

function DeskTop() {
  return (
    <>
      <Link href="/demo" className="flex items-center gap-2 text-ink">
        <ForkMark size={24} />
        <span className="label">Desk demo</span>
      </Link>
      <span className="label flex items-center gap-1.5">
        <DeskIcon size={16} /> No walking
      </span>
    </>
  );
}

function CityButton({ city, disabled, onPick }: { city: DeskCity; disabled: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      data-testid={`city-${city.id}`}
      className="flex min-h-14 w-full items-center justify-between gap-3 rounded-[10px] border-[1.5px] border-ink/25 bg-card px-4 py-2.5 text-left active:bg-ink/5 disabled:opacity-50"
    >
      <span>
        <span className="block text-[16px] font-semibold">{city.name}</span>
        <span className="block text-[13px] text-muted">{city.area}</span>
      </span>
      <span className={`font-mono text-[11px] ${city.tested ? "rounded-full bg-ink px-2 py-0.5 text-paper" : "text-muted"}`}>
        {city.tested ? "tested" : "not tested yet"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The quest, line by line

let player: HTMLAudioElement | null = null;

function PlayLine({ questId, line, onPlaying }: { questId: string; line: QuestViewLine; onPlaying: (key: string | null) => void }) {
  const [state, setState] = useState<{ s: "idle" | "loading" | "playing" } | { s: "text"; why: string }>({ s: "idle" });
  const live = useRef(true);
  // Set in the effect body too: React's development double mount runs the cleanup once first.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const play = async () => {
    if (state.s === "playing") {
      player?.pause();
      setState({ s: "idle" });
      onPlaying(null);
      return;
    }
    setState({ s: "loading" });
    try {
      const res = await fetchQuestLine(questId, line.key);
      if (!live.current) return;
      if (!res.line.clipId) {
        setState({ s: "text", why: res.reason ?? "This line shows as text." });
        return;
      }
      player?.pause();
      player = new Audio(API.audio(res.line.clipId));
      player.onended = () => {
        if (live.current) setState({ s: "idle" });
        onPlaying(null);
      };
      await player.play();
      setState({ s: "playing" });
      onPlaying(line.key);
    } catch (err) {
      if (live.current) setState({ s: "text", why: err instanceof ApiFailure ? err.message : "The line could not be played." });
    }
  };

  return (
    <div className="mt-1.5 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => void play()}
        disabled={state.s === "loading"}
        data-testid={`play-${line.key}`}
        className="flex h-9 items-center gap-1.5 rounded-full border-[1.5px] border-ink/30 pl-2.5 pr-3.5 text-[13px] font-medium active:bg-ink/5 disabled:opacity-60"
      >
        {state.s === "playing" ? <StopIcon size={14} /> : <PlayIcon size={14} />}
        {state.s === "loading" ? "Voicing…" : state.s === "playing" ? "Stop" : "Play this line"}
      </button>
      {state.s === "text" ? <span className="text-[12.5px] leading-snug text-muted" data-testid="line-text-only">{state.why}</span> : null}
    </div>
  );
}

function Line({ questId, label, line, onPlaying }: { questId: string; label: string; line: QuestViewLine; onPlaying: (k: string | null) => void }) {
  return (
    <div className="mt-3">
      <p className="label mb-1">{label}</p>
      <p className="narration text-[17px] leading-[1.4]">{line.text}</p>
      {line.facts?.length ? <p className="mt-1 font-mono text-[11px] text-muted">cites {line.facts.join(", ")}</p> : null}
      <PlayLine questId={questId} line={line} onPlaying={onPlaying} />
    </div>
  );
}

function QuestPreview({
  made,
  onBack,
  onPlay,
  startLog,
  startError,
}: {
  made: Made;
  onBack: () => void;
  onPlay: () => void;
  startLog: string[] | null;
  startError: string | null;
}) {
  const { view, made: res } = made;
  const [, setPlaying] = useState<string | null>(null);
  const q = view.questId;
  return (
    <Screen
      top={<DeskTop />}
      actions={
        <PrimaryButton onClick={onPlay} disabled={startLog !== null} testId="preview-play" icon={<ArrowRightIcon size={20} />}>
          {startLog ? "Starting…" : "Play this case from your desk"}
        </PrimaryButton>
      }
    >
      <section className="pt-5" data-testid="quest-preview">
        <button type="button" onClick={onBack} className="label underline underline-offset-2">
          ← Another place
        </button>
        <p className="label mt-4">
          {res.overCap ? "Nearest saved case (today's limit reached)" : res.reused ? "A saved case" : "A new case"} ·{" "}
          {view.stopsPerRun} stops · {view.places.filter((p) => p.fork).length} fork
          {view.writer ? ` · written by ${view.writer.replace(/^[a-z]+\//, "")}` : ""}
        </p>
        <h1 className="narration mt-2 text-[32px] font-[560] leading-[1.08]" data-testid="preview-title">
          {view.title}
        </h1>
        <div className="mt-4 border-l-[3px] border-ink pl-4">
          <Label className="mb-1">The question</Label>
          <p className="narration text-[20px] italic leading-[1.35]">{view.mystery.question}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-[14px] font-medium text-link">Show the answer</summary>
            <p className="mt-2 text-[15px] leading-snug">{view.mystery.answer}</p>
            <p className="mt-1 font-mono text-[11px] text-muted">cites {view.mystery.facts.join(", ")}</p>
          </details>
        </div>
        <Line questId={q} label="The briefing" line={view.briefing} onPlaying={setPlaying} />
      </section>

      {startError ? (
        <div className="mt-5">
          <ErrorNote>{startError}</ErrorNote>
        </div>
      ) : null}
      {startLog ? <StartLog log={startLog} /> : null}

      <section className="mt-6 flex flex-col gap-4" data-testid="preview-places">
        {view.places.map((p, i) => (
          <article key={p.id} className="rounded-[12px] border border-rule bg-card p-4">
            <p className="label">
              {p.role === "start" ? "Start" : p.role === "answer" ? "The answer place" : `Stop · ${p.id}`}
              {p.fork ? " · fork" : ""}
            </p>
            <h2 className="mt-1 text-[19px] font-semibold leading-snug">
              <span className="font-mono text-[13px] text-muted">{String(i + 1).padStart(2, "0")} </span>
              {p.name}
            </h2>
            <Line questId={q} label="Clue" line={p.clue} onPlaying={setPlaying} />
            <Line questId={q} label="At the place" line={p.look} onPlaying={setPlaying} />
            <Line questId={q} label="The reveal" line={p.reveal} onPlaying={setPlaying} />
            {p.links.length > 0 ? (
              <div className="mt-4 border-t border-dashed border-rule pt-3">
                <p className="label mb-1">{p.fork ? "The ways on (by the detail photographed)" : "The way on"}</p>
                {p.links.map((l) => (
                  <div key={l.to} className="mt-2" data-testid="preview-link">
                    <p className="text-[14px] font-medium">
                      {l.cue ? <span className="mr-2 rounded-full bg-ink px-2 py-0.5 font-mono text-[11px] text-paper">{CUE_TAG[l.cue]}</span> : null}→{" "}
                      {l.toName}
                    </p>
                    <p className="narration mt-1 text-[16px] leading-[1.4]">{l.reason.text}</p>
                    {l.reason.facts?.length ? <p className="mt-1 font-mono text-[11px] text-muted">cites {l.reason.facts.join(", ")}</p> : null}
                    <PlayLine questId={q} line={l.reason} onPlaying={setPlaying} />
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </section>

      <section className="mt-6">
        <Line questId={q} label="The finale" line={view.finale} onPlaying={setPlaying} />
      </section>

      <section className="mt-8">
        <Label className="mb-3">Every fact in this case</Label>
        <div className="flex flex-col gap-3" data-testid="preview-facts">
          {view.facts.map((f) => (
            <FactCard key={f.id} fact={f} />
          ))}
        </div>
        {view.editedByHand.length > 0 ? (
          <p className="mt-4 text-[13px] leading-snug text-muted">
            Gemma wrote this case from the fetched facts; {view.editedByHand.length} lines were edited by hand.
          </p>
        ) : null}
      </section>
    </Screen>
  );
}
