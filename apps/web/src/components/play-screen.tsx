"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { COMPASS_NAMES } from "@/lib/geo";
import { getApi } from "@/play/api-browser";
import { Narrator } from "@/play/audio";
import { ApiFailure } from "@/play/client";
import { COMPASS_DEG, CUE_TAG, distanceText } from "@/play/labels";
import { type GpsResult, preparePhoto, readPosition } from "@/play/photo";
import { savePhoto } from "@/play/photo-store";
import { summarize, toReceipt } from "@/play/receipt";
import {
  afterResult,
  applyResult,
  arrive,
  backToLook,
  cameraOpened,
  checking,
  finishLocal,
  replayed,
  restore,
  type RunState,
  sampleSent,
  toClue,
  toPocket,
  visibility,
  withFinish,
} from "@/play/run-state";
import { readRun, updateRun, useRun } from "@/play/run-store";
import { deskSamplesFor, type DemoSample, sampleUrl } from "@/quest/demo-samples";
import { RouteSoFar, SampleCredit, SamplePicker, sentSample, StoredNote, VerdictDetail } from "./desk";
import { useRunPhotos } from "./use-run-photos";
import { ArrowRightIcon, ArrowUpIcon, CameraIcon, ForkMark, LockIcon, ReplayIcon } from "./icons";
import {
  CameraButton,
  ErrorNote,
  FactList,
  Label,
  Narration,
  NarratorContext,
  PhaseHeading,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Snapshot,
  Stamp,
  TopBar,
} from "./ui";

/** The pocket screen's colour (--pocket in globals.css), for the browser's bars. */
const POCKET_THEME = "#0f0e0c";

const caseNo = (runId: string) => `Case ${runId.slice(-4).toUpperCase()}`;

export function PlayScreen({ runId }: { runId: string }) {
  const run = useRun(runId);
  const [narrator] = useState(() => (typeof window === "undefined" ? null : new Narrator()));

  // Keep the walk across reloads and locks: fix a lost photo check, then log visibility.
  useEffect(() => {
    if (!readRun(runId)) return;
    updateRun(runId, (s) => restore(s, Date.now(), document.visibilityState === "visible"));
    const onVis = (e: Event) => {
      // Locked with the side button, or switched away: nothing plays while the player walks.
      if (e.type === "pagehide" || document.visibilityState === "hidden") narrator?.stopAll("hidden");
      updateRun(runId, (s) => visibility(s, document.visibilityState === "visible", Date.now()));
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onVis);
    };
  }, [runId, narrator]);

  const ambienceId = run?.start.ambienceClipId;
  const mock = run?.mock;
  useEffect(() => {
    if (!narrator) return;
    narrator.setAmbience(ambienceId);
    if (mock) Object.assign(window, { __fpAudioLog: narrator.log, __fpAudioPaused: narrator.paused });
  }, [narrator, ambienceId, mock]);

  useEffect(() => () => narrator?.dispose(), [narrator]);

  if (run === undefined) return <Loading />;
  if (run === null) return <NotOnThisPhone />;
  return (
    <NarratorContext.Provider value={narrator}>
      <Walk run={run} narrator={narrator} />
    </NarratorContext.Provider>
  );
}

function Loading() {
  return (
    <Screen>
      <p className="label m-auto">Opening the case…</p>
    </Screen>
  );
}

function NotOnThisPhone() {
  return (
    <Screen actions={<LinkButton href="/">Start a new walk</LinkButton>}>
      <div className="m-auto max-w-[320px] text-center">
        <Label className="mb-3">Case not found</Label>
        <p className="narration text-[24px] leading-snug">This walk lives on the phone that started it.</p>
      </div>
    </Screen>
  );
}

function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex min-h-14 w-full items-center justify-center gap-2 rounded-[10px] bg-stamp px-5 text-[17px] font-semibold text-stamp-ink"
    >
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------

function Walk({ run, narrator }: { run: RunState; narrator: Narrator | null }) {
  const router = useRouter();
  const api = getApi(run.mock);
  const gps = useRef<Promise<GpsResult> | null>(null);
  const [preview, setPreview] = useState<{ placeId: string; url: string; blob: Blob; sampleId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const { photos, refresh } = useRunPhotos(run.runId);

  // A new screen: move focus to its heading, so a screen reader hears what changed.
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-phase-heading]")?.focus({ preventScroll: true });
  }, [run.phase, run.stop.placeId]);

  // Pocket mode is dark: the browser's bars follow it, and go back to paper after.
  const pocketPhase = run.phase === "pocket";
  useEffect(() => {
    if (!pocketPhase) return;
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const before = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = POCKET_THEME));
    let added: HTMLMetaElement | null = null;
    if (metas.length === 0) {
      added = document.createElement("meta");
      added.name = "theme-color";
      added.content = POCKET_THEME;
      document.head.appendChild(added);
    }
    return () => {
      metas.forEach((m, i) => (m.content = before[i]));
      added?.remove();
    };
  }, [pocketPhase]);

  const set = (fn: (s: RunState) => RunState) => updateRun(run.runId, fn);
  const tap = () => narrator?.unlock();
  /**
   * The tap that opens the next screen starts its main line (iOS lets a tap start playback);
   * `play` stops the line before, and the ambience carries on under a clue. With no clip for the
   * next line, everything stops.
   */
  const advance = (stopTag: string, line: { clipId?: string } | null | undefined, opts: { withAmbience?: boolean; tag: string }) => {
    if (line?.clipId && narrator) void narrator.play(line.clipId, opts);
    else narrator?.stopAll(stopTag);
  };
  const stop = run.stop;
  const desk = run.desk === true;
  const samples = desk ? deskSamplesFor(run.start.questId, stop.placeId) : [];
  const top = (right?: React.ReactNode, tone: "paper" | "pocket" = "paper") => (
    <TopBar tone={tone} left={caseNo(run.runId)} right={right ?? `Stop ${stop.stop} of ${stop.of}`} />
  );

  const goPocket = () => {
    narrator?.stopAll("pocket");
    setError(null);
    set((s) => toPocket(s, Date.now()));
  };

  const imHere = () => {
    tap();
    narrator?.stopAll("arrive");
    // Once, now: pages get no GPS while locked. The desk demo treats GPS as missing.
    gps.current = desk ? Promise.resolve({ ok: false, reason: "unavailable" }) : readPosition(12_000);
    set((s) => arrive(s, Date.now()));
  };

  const sendPhoto = async (blob: Blob, sampleId: string | null = null) => {
    setError(null);
    set((s) => checking(desk ? sampleSent(s, stop.placeId, sampleId) : s));
    try {
      const fix: GpsResult = desk ? { ok: false, reason: "unavailable" } : await (gps.current ?? readPosition(8_000));
      const fields = {
        placeId: stop.placeId,
        ...(fix.ok ? { lat: fix.fix.lat, lng: fix.fix.lng, accuracy: fix.fix.accuracy } : {}),
        ...(sampleId ? { sampleId } : {}),
      };
      const result = await api.sendPhoto(run.runId, blob, fields);
      set((s) => applyResult(s, result));
      if (result.status === "passed" || result.status === "skipped") {
        void narrator?.stinger(result.status === "passed" ? run.start.stingers.found : run.start.stingers.notHere, "result");
        // The server has moved the run on; a phone that cannot store photos only loses the case-file picture.
        try {
          await savePhoto(run.runId, stop.placeId, blob);
          refresh();
        } catch {
          // ignored: the case file says "No photos on this phone"
        }
      } else {
        void narrator?.stinger(run.start.stingers.notHere, result.status);
        gps.current = null; // read again on the next "I'm here"
      }
    } catch (err) {
      set(backToLook);
      setError(err instanceof ApiFailure ? err.message : "The photo could not be sent. Try again.");
    }
  };

  const onPick = async (file: File) => {
    setError(null);
    set((s) => cameraOpened(s, Date.now())); // also when the camera was opened without a click event
    try {
      const prepared = await preparePhoto(file);
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ placeId: stop.placeId, url: URL.createObjectURL(prepared.blob), blob: prepared.blob, sampleId: null });
      await sendPhoto(prepared.blob);
    } catch {
      setError("This photo could not be read. Take another one.");
    }
  };

  /** Desk demo: send a sample photo as it is (already ≤ 1024 px, no EXIF), with its id. */
  const onSample = async (sample: DemoSample) => {
    tap();
    setError(null);
    set((s) => cameraOpened(s, Date.now()));
    try {
      const res = await fetch(sampleUrl(sample));
      if (!res.ok) throw new Error(String(res.status));
      const blob = new Blob([await res.arrayBuffer()], { type: "image/jpeg" });
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ placeId: stop.placeId, url: URL.createObjectURL(blob), blob, sampleId: sample.id });
      await sendPhoto(blob, sample.id);
    } catch {
      setError("The sample photo could not be loaded. Try again.");
    }
  };

  const picker = (
    <SamplePicker samples={samples} fork={stop.isFork} disabled={run.phase === "checking"} onSample={onSample} onOwnPhoto={onPick} />
  );

  const openCamera = () => {
    tap();
    set((s) => cameraOpened(s, Date.now()));
  };

  const finish = async () => {
    setFinishing(true);
    narrator?.stopAll("finish");
    const now = Date.now();
    set((s) => finishLocal(s, now));
    const ended = readRun(run.runId);
    if (ended) {
      try {
        const res = await api.finish(run.runId, { receipt: toReceipt(summarize(ended.timeline, now)) });
        set((s) => withFinish(s, res));
      } catch {
        // The case file still opens; the receipt says it was not saved.
      }
    }
    router.push(`/end/${encodeURIComponent(run.runId)}`);
  };

  const photoUrl = (placeId: string) =>
    preview?.placeId === placeId ? preview.url : photos.find((p) => p.placeId === placeId)?.url;

  // -------------------------------------------------------------------------

  switch (run.phase) {
    case "briefing":
      return (
        <Screen
          top={top("Briefing")}
          actions={
            <PrimaryButton
              testId="to-clue"
              icon={<ArrowRightIcon size={20} />}
              onClick={() => {
                tap();
                set(toClue);
                advance("to-clue", stop.clue, { withAmbience: true, tag: "clue" });
              }}
            >
              To the first clue
            </PrimaryButton>
          }
        >
          <div className="pt-6">
            <Label>The case</Label>
            <h1
              className="narration mt-2 text-[36px] font-[560] leading-[1.08] tracking-[-0.01em] outline-none"
              tabIndex={-1}
              data-phase-heading=""
            >
              {run.start.title}
            </h1>
            <div className="mt-5 border-l-[3px] border-ink pl-4">
              <Label className="mb-1">The question</Label>
              <p className="narration text-[21px] italic leading-[1.35]" data-testid="mystery">
                {run.start.mystery}
              </p>
            </div>
          </div>
          <div className="mt-8">
            <Narration line={run.start.briefing} label="The narrator" withAmbience tag="briefing" testId="briefing" />
            {run.start.voice ? null : (
              <p className="label mt-3 pl-6" data-testid="voice-off">
                Voice off · text only
              </p>
            )}
          </div>
          <SafetyNote />
        </Screen>
      );

    case "clue":
      return (
        <Screen
          top={top(stop.isFork ? `Stop ${stop.stop} of ${stop.of} · Fork` : undefined)}
          actions={
            desk ? (
              <PrimaryButton testId="desk-arrive" icon={<ArrowRightIcon size={20} />} onClick={imHere}>
                Skip the walk: I&apos;m there
              </PrimaryButton>
            ) : (
              <PrimaryButton testId="go" icon={<LockIcon size={20} />} onClick={goPocket}>
                Lock your phone. Go.
              </PrimaryButton>
            )
          }
        >
          <PhaseHeading>
            Clue {stop.stop} of {stop.of}
          </PhaseHeading>
          <Progress at={stop.stop} of={stop.of} />
          {desk ? <RouteSoFar run={run} /> : null}
          <div className="mt-8">
            <Narration line={stop.clue} label={`Clue ${stop.stop}`} size="xl" withAmbience tag="clue" testId="clue" />
          </div>
          <p className="mt-auto pt-8 text-[15px] leading-relaxed text-muted">
            {desk ? (
              <>
                On the street you would lock your phone and walk there, with nothing playing. At a desk, skip ahead.
              </>
            ) : (
              <>
                Walk there with the phone in your pocket. When you can see it, unlock and tap{" "}
                <span className="font-semibold text-ink">I&apos;m here</span>.
              </>
            )}
          </p>
        </Screen>
      );

    case "pocket":
      return (
        <Screen
          tone="pocket"
          top={
            <>
              <span className="flex items-center gap-2">
                <span className="breathe block h-2 w-2 rounded-full bg-pocket-ink" />
                <span className="label !text-pocket-muted">Walking · stop {stop.stop} of {stop.of}</span>
              </span>
              <span className="label !text-pocket-muted">{caseNo(run.runId)}</span>
            </>
          }
          actions={
            <>
              <PrimaryButton testId="im-here" onClick={imHere}>
                I&apos;m here
              </PrimaryButton>
              <SecondaryButton
                tone="pocket"
                testId="replay"
                icon={<ReplayIcon size={18} />}
                onClick={() => {
                  tap();
                  set((s) => toClue(replayed(s, Date.now())));
                  advance("replay", stop.clue, { withAmbience: true, tag: "clue" });
                }}
              >
                {stop.clue.clipId ? "Hear the clue again" : "Read the clue again"}
              </SecondaryButton>
            </>
          }
        >
          <div className="my-auto py-10" data-testid="pocket">
            <h1
              className="narration text-[64px] font-[520] leading-[0.98] tracking-[-0.02em] text-pocket-ink outline-none"
              tabIndex={-1}
              data-phase-heading=""
            >
              Lock your phone. Go.
            </h1>
            <p className="mt-6 max-w-[300px] text-[17px] leading-relaxed text-pocket-muted">
              Nothing plays while you walk. Listen to the street.
            </p>
          </div>
          <p className="font-mono text-[11.5px] leading-relaxed text-pocket-muted">
            Unlocking on the way counts as a peek, unless you tap I&apos;m here within 20 seconds. Replaying the clue
            counts as one too.
          </p>
        </Screen>
      );

    case "look":
      return (
        <Screen
          top={top(`Stop ${stop.stop} of ${stop.of} · At the place`)}
          actions={
            desk ? undefined : (
              <CameraButton testId="camera" onOpen={openCamera} onPick={onPick} icon={<CameraIcon size={22} />}>
                {error && preview?.placeId === stop.placeId ? "Take another photo" : "Take the photo"}
              </CameraButton>
            )
          }
        >
          <PhaseHeading>At the place: stop {stop.stop} of {stop.of}</PhaseHeading>
          {desk ? <RouteSoFar run={run} /> : null}
          <div className="mt-6">
            <Narration line={stop.look} label="At the place" tag="look" testId="look" />
          </div>
          {stop.isFork ? (
            <div className="mt-6 flex gap-3 rounded-[10px] border-[1.5px] border-ink/80 bg-card p-4" data-testid="fork-note">
              <ForkMark size={30} className="shrink-0 text-ink" />
              <p className="text-[15px] leading-snug">
                <span className="font-semibold">This is a fork.</span> The detail you photograph picks your next stop.
                Every way ends at the same answer.
              </p>
            </div>
          ) : null}
          {desk ? null : (
            <p className="mt-5 text-[14px] leading-relaxed text-muted">
              One detail, close up. Keep people out of the frame, and stay on the pavement.
            </p>
          )}
          {error ? (
            <div className="mt-5 flex flex-col gap-3">
              <ErrorNote>{error}</ErrorNote>
              {preview?.placeId === stop.placeId ? (
                <SecondaryButton onClick={() => void sendPhoto(preview.blob, preview.sampleId)}>Send the same photo again</SecondaryButton>
              ) : null}
            </div>
          ) : null}
          {desk ? picker : <GpsLine gps={gps} />}
        </Screen>
      );

    case "checking":
      return (
        <Screen top={top()}>
          <div className="mt-8 px-6">
            {photoUrl(stop.placeId) ? (
              <div className="relative">
                <Snapshot src={photoUrl(stop.placeId)!} rotate={-1.5} />
                <div aria-hidden className="pointer-events-none absolute inset-2 bottom-3 overflow-hidden">
                  <div className="scan h-full w-full bg-gradient-to-b from-transparent via-paper/40 to-transparent" />
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-10 text-center" aria-live="polite">
            <Label as="h1">Gemma is looking</Label>
            <p className="narration mx-auto mt-3 max-w-[300px] text-[21px] leading-snug">
              Checking you are at the place, and reading the detail you chose.
            </p>
          </div>
        </Screen>
      );

    case "result": {
      const r = run.result!;
      const url = photoUrl(r.placeId);
      const sample = desk ? sentSample(run, r.placeId) : null;
      return (
        <Screen
          top={top()}
          actions={
            <PrimaryButton
              testId="after-result"
              icon={<ArrowRightIcon size={20} />}
              onClick={() => {
                tap();
                set(afterResult);
                if (r.next) advance("after-result", r.next.bridge.line, { tag: "bridge" });
                else advance("after-result", r.end?.finale.line, { tag: "finale" });
              }}
            >
              {r.next ? (stop.isFork ? "Which way next?" : "On to the next stop") : "Hear how it ends"}
            </PrimaryButton>
          }
        >
          <div className="relative pt-6">
            <Label>
              Stop {stop.stop} · {r.status === "passed" ? "found" : "skipped"}
            </Label>
            <h1
              className="narration mt-2 pr-32 text-[34px] font-[560] leading-[1.08] outline-none"
              data-testid="place-name"
              tabIndex={-1}
              data-phase-heading=""
            >
              {r.name}
            </h1>
            <div className="absolute right-0 top-7">
              <Stamp tone={r.status === "passed" ? "ink" : "muted"} rotate={-9}>
                {r.status === "passed" ? "Found" : "Skipped"}
              </Stamp>
            </div>
          </div>
          {r.status === "skipped" ? (
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              This stop could not be confirmed, so the walk moves on. You still get the story.
            </p>
          ) : null}
          {url || r.verdict ? (
            <div className="mt-6 grid grid-cols-[112px_1fr] items-start gap-4">
              {url ? (
                <div>
                  <Snapshot src={url} rotate={-2.5} alt={`Your photo at ${r.name}`} />
                  {sample ? <SampleCredit sample={sample} className="mt-2" /> : null}
                </div>
              ) : (
                <span />
              )}
              <div data-testid="observed">
                <Label className="mb-1.5">{r.verdict ? "What Gemma saw" : "The photo check"}</Label>
                {r.verdict ? (
                  <>
                    <p className="narration text-[19px] italic leading-snug">{r.verdict.observed}</p>
                    {desk ? <VerdictDetail verdict={r.verdict} fork={stop.isFork} /> : null}
                    {r.verdict.source === "stored" ? desk ? <StoredNote /> : <p className="label mt-2">Stored result</p> : null}
                  </>
                ) : (
                  <p className="text-[15px] leading-snug text-muted">
                    The photo reader did not answer. GPS put you here, and that is enough.
                  </p>
                )}
              </div>
            </div>
          ) : null}
          <hr className="dashed-rule my-7" />
          <Narration line={r.reveal.line} label="The reveal" tag="reveal" testId="reveal" />
          <FactList facts={r.reveal.facts} />
        </Screen>
      );
    }

    case "bridge": {
      const r = run.result!;
      const next = r.next!;
      const atFork = next.chosenBy !== "only-link";
      return (
        <Screen
          top={top(`Stop ${stop.stop} → ${next.stop.stop}`)}
          actions={
            <PrimaryButton
              testId="to-next-clue"
              icon={<ArrowRightIcon size={20} />}
              onClick={() => {
                tap();
                set(toClue);
                advance("to-clue", next.stop.clue, { withAmbience: true, tag: "clue" });
              }}
            >
              To clue {next.stop.stop}
            </PrimaryButton>
          }
        >
          {desk ? <RouteSoFar run={run} /> : null}
          <div className="pt-6">
            <Label as="h1">{atFork ? "The fork" : "The way on"}</Label>
            {atFork && r.verdict ? (
              <div className="mt-4 rounded-[12px] border border-rule bg-card p-4" data-testid="fork-choice">
                <p className="label mb-1">You photographed{r.verdict.source === "stored" ? " · stored result" : ""}</p>
                <p className="narration text-[20px] italic leading-snug">{r.verdict.observed}</p>
                <div className="mt-4 flex items-center gap-3">
                  {r.verdict.cue ? (
                    <span className="rounded-full bg-ink px-3 py-1.5 font-mono text-[12px] font-medium text-paper">
                      {CUE_TAG[r.verdict.cue]}
                    </span>
                  ) : (
                    <span className="font-mono text-[12px] text-muted">closest match</span>
                  )}
                  <svg width="48" height="12" viewBox="0 0 48 12" aria-hidden className="text-ink">
                    <path d="M1 6h44M39 1l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <span className="font-mono text-[12px] font-medium">Stop {next.stop.stop}</span>
                </div>
                <p className="mt-3 text-[13px] leading-snug text-muted">
                  {next.chosenBy === "cue"
                    ? "Your detail matched one of the ways out of this place."
                    : next.chosenBy === "meaning"
                      ? "Gemma picked the way closest in meaning to your detail."
                      : "No way matched your detail, so the walk takes the nearest one."}{" "}
                  The other ways stay closed until the case file.
                </p>
              </div>
            ) : atFork ? (
              <p className="mt-3 text-[15px] leading-snug text-muted" data-testid="fork-fallback">
                The photo reader did not answer, so the walk takes the nearest way on. The other ways stay closed until
                the case file.
              </p>
            ) : null}
          </div>
          <div className="mt-7">
            <Narration line={next.bridge.line} label="The narrator" tag="bridge" testId="bridge" />
          </div>
          <FactList facts={next.bridge.facts} />
        </Screen>
      );
    }

    case "too-far": {
      const m = run.miss!;
      if (m.status !== "too-far") return null;
      return (
        <Screen
          top={top(`Stop ${stop.stop} of ${stop.of} · Not here yet`)}
          actions={
            <>
              <PrimaryButton testId="go" icon={<LockIcon size={20} />} onClick={goPocket}>
                Lock your phone. Go.
              </PrimaryButton>
              <SecondaryButton testId="check-again" onClick={imHere}>
                I&apos;m here: check again
              </SecondaryButton>
            </>
          }
        >
          <div className="pt-6" data-testid="too-far">
            <Label as="h1">Not here yet</Label>
            <div className="mt-4 flex items-center gap-5">
              <span
                className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-full border-[2.5px] border-ink"
                aria-hidden
              >
                <ArrowUpIcon size={40} style={{ transform: `rotate(${COMPASS_DEG[m.hint.direction]}deg)` }} />
              </span>
              <div>
                <p className="font-mono text-[30px] font-semibold leading-none tracking-[-0.02em]" data-testid="distance">
                  {distanceText(m.hint.distanceM)}
                </p>
                <p className="mt-1.5 text-[17px] font-medium">to the {COMPASS_NAMES[m.hint.direction]}</p>
              </div>
            </div>
            <p className="mt-3 text-[13px] leading-snug text-muted">
              In a straight line from where your phone thinks you are. The arrow points north-up, like a map.
            </p>
          </div>
          <div className="mt-8">
            <Narration line={m.hint.line} label="A hint" tag="hint" testId="hint" />
          </div>
          <p className="mt-6 font-mono text-[12px] leading-relaxed text-muted">
            {m.retriesLeft > 0
              ? `${m.retriesLeft} more ${m.retriesLeft === 1 ? "try" : "tries"} here, then the walk moves on.`
              : "Next time, the walk moves on and you still hear the story."}
          </p>
        </Screen>
      );
    }

    case "needs-retry": {
      const m = run.miss!;
      if (m.status !== "needs-retry") return null;
      const url = photoUrl(stop.placeId);
      return (
        <Screen
          top={top()}
          actions={
            desk ? undefined : (
              <CameraButton testId="camera" onOpen={openCamera} onPick={onPick} icon={<CameraIcon size={22} />}>
                Take another photo
              </CameraButton>
            )
          }
        >
          <div className="pt-6">
            <Label as="h1">Try another photo</Label>
            <div className="mt-5 grid grid-cols-[112px_1fr] items-start gap-4">
              {url ? <Snapshot src={url} rotate={2} /> : <span />}
              <div>
                <Label className="mb-1.5">What Gemma saw</Label>
                <p className="narration text-[19px] italic leading-snug">{m.verdict.observed}</p>
              </div>
            </div>
          </div>
          <div className="mt-8">
            <Narration line={m.message} label="The narrator" tag="retry" />
          </div>
          {error ? (
            <div className="mt-5">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}
          {desk ? picker : null}
        </Screen>
      );
    }

    case "finale": {
      const end = run.end!;
      return (
        <Screen
          top={top("The answer")}
          actions={
            <PrimaryButton testId="open-case-file" onClick={finish} disabled={finishing}>
              {finishing ? "Closing the case…" : "Open the case file"}
            </PrimaryButton>
          }
        >
          <div className="relative pt-6">
            <PhaseHeading>The answer</PhaseHeading>
            <Label>The question</Label>
            <p className="narration mt-2 pr-4 text-[23px] italic leading-[1.3]">{end.caseFile.mystery.question}</p>
            <div className="relative mt-9 rounded-[12px] border-[1.5px] border-ink bg-card p-5 pt-6">
              <Label className="mb-2">The answer</Label>
              <p className="narration text-[24px] font-[560] leading-[1.25]" data-testid="answer">
                {end.caseFile.mystery.answer}
              </p>
              <div className="pointer-events-none absolute -top-6 right-3">
                <Stamp tone="red" rotate={-8} className="bg-card/70 !text-[28px]">
                  Solved
                </Stamp>
              </div>
            </div>
          </div>
          <div className="mt-8">
            <Narration line={end.finale.line} label="The narrator" tag="finale" testId="finale" />
          </div>
          <FactList facts={end.finale.facts} label="Cited in the answer" />
        </Screen>
      );
    }
  }
}

function SafetyNote() {
  return (
    <aside className="mt-8 rounded-[10px] bg-ink px-4 py-3.5 text-paper" data-testid="safety">
      <p className="text-[16px] font-semibold">Stay on the pavement, daylight only.</p>
      <p className="mt-1 text-[14px] leading-snug text-paper/80">
        Clues never send you onto a road or into private property. Never photograph people. There is no rush.
      </p>
    </aside>
  );
}

function Progress({ at, of }: { at: number; of: number }) {
  return (
    <div className="mt-6 flex items-center gap-2" role="img" aria-label={`Stop ${at} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 flex-1 rounded-full ${i < at - 1 ? "bg-ink" : i === at - 1 ? "bg-ink/60" : "bg-ink/15"}`}
        />
      ))}
    </div>
  );
}

/** "GPS ±12 m" once the reading taken at "I'm here" is back. */
function GpsLine({ gps }: { gps: React.RefObject<Promise<GpsResult> | null> }) {
  const [state, setState] = useState<GpsResult | "reading" | null>(null);
  useEffect(() => {
    let live = true;
    const p = gps.current;
    if (!p) return;
    Promise.resolve()
      .then(() => live && setState("reading"))
      .then(() => p)
      .then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [gps]);
  if (!state) return null;
  const text =
    state === "reading"
      ? "GPS · reading…"
      : state.ok
        ? `GPS · ±${state.fix.accuracy} m`
        : state.reason === "denied"
          ? "GPS · blocked: the photo decides"
          : "GPS · no fix: the photo decides";
  return <p className="mt-auto pt-6 font-mono text-[11.5px] text-muted" data-testid="gps">{text}</p>;
}
