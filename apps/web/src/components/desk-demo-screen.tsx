"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getApi } from "@/play/api-browser";
import { preloadClips } from "@/play/audio";
import { ApiFailure } from "@/play/client";
import { newRun } from "@/play/run-state";
import { writeRun } from "@/play/run-store";
import { DESK_QUEST_ID, sampleUrl, samplesFor } from "@/quest/demo-samples";
import { ArrowRightIcon, DeskIcon, ForkMark, PinIcon } from "./icons";
import { ErrorNote, Label, PrimaryButton, Screen } from "./ui";

/**
 * Starts a desk run: a normal run of a saved quest, with GPS treated as missing and sample photos
 * at each stop (the demo quest only). Shared by /demo and the quest preview on /demo/near.
 */
export function useDeskStart() {
  const router = useRouter();
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (questId: string) => {
    setError(null);
    const lines: string[] = [];
    const say = (line: string, replaceLast = false) => {
      if (replaceLast) lines.pop();
      lines.push(line);
      setLog([...lines]);
    };
    try {
      const api = getApi(false);
      say("Opening the saved case…");
      const run = await api.startRun({ questId });
      say(run.voice ? "The narrator is ready." : "Voice is off: every line shows as text.", true);
      if (run.preload.length > 0) {
        say(`Loading audio 0/${run.preload.length}`);
        await preloadClips(run.preload, (done, total) => say(`Loading audio ${done}/${total}`, true));
      }
      writeRun(newRun(run, false, Date.now(), { desk: true }));
      router.push(`/play/${encodeURIComponent(run.runId)}`);
    } catch (err) {
      setLog(null);
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    }
  };
  return { start, log, error };
}

export function StartLog({ log }: { log: string[] }) {
  return (
    <ol className="mt-5 space-y-1 font-mono text-[13px] leading-relaxed text-ink" aria-live="polite" data-testid="start-log">
      {log.map((l, i) => (
        <li key={i} className="rise flex gap-2">
          <span className="text-muted">{String(i + 1).padStart(2, "0")}</span>
          {l}
        </li>
      ))}
    </ol>
  );
}

/** /demo: "Try it from your desk". */
export function DeskDemoScreen() {
  const { start, log, error } = useDeskStart();
  const fork = samplesFor("P1");

  return (
    <Screen
      top={
        <>
          <Link href="/" className="flex items-center gap-2 text-ink">
            <ForkMark size={24} />
            <span className="label">A walking mystery</span>
          </Link>
          <span className="label flex items-center gap-1.5">
            <DeskIcon size={16} /> Desk demo
          </span>
        </>
      }
      actions={
        <PrimaryButton onClick={() => void start(DESK_QUEST_ID)} disabled={log !== null} testId="desk-start" icon={<ArrowRightIcon size={20} />}>
          {log ? "Starting…" : "Start the Karaköy case"}
        </PrimaryButton>
      }
    >
      <section className="pt-6">
        <h1 className="narration text-[40px] font-[560] leading-[1.02] tracking-[-0.02em]">Try it from your desk</h1>
        <p className="mt-4 text-[16px] leading-[1.55] text-ink" data-testid="desk-intro">
          Play the saved case below Galata Tower in Istanbul, with sample photos instead of a walk. No location needed.
        </p>
        <p className="mt-2 text-[16px] leading-[1.55] text-muted">
          At the fork, the detail you pick sends you to a different stop, and every way ends at the same answer.
        </p>
      </section>

      <section className="mt-6 rounded-[12px] border border-rule bg-card p-4 shadow-[0_1px_0_rgb(28_26_23/0.06)]">
        <Label className="mb-3">The first fork: two details, two ways on</Label>
        <div className="grid grid-cols-2 gap-3">
          {fork.map((s) => (
            <figure key={s.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a small static sample */}
              <img src={sampleUrl(s)} alt={s.detail} width={s.width} height={s.height} className="aspect-square w-full rounded-[8px] object-cover" />
              <figcaption className="mt-1.5 text-[13.5px] font-medium leading-tight">{s.detail}</figcaption>
            </figure>
          ))}
        </div>
        <p className="mt-3 font-mono text-[11.5px] leading-snug text-muted">
          3 stops · 1 fork · photos from Wikimedia Commons, credited at each stop
        </p>
      </section>

      {error ? (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      {log ? <StartLog log={log} /> : null}

      <Link
        href="/demo/near"
        data-testid="desk-near"
        className="mt-6 flex min-h-14 items-center gap-3 rounded-[10px] border-[1.5px] border-link px-4 py-3 text-link"
      >
        <PinIcon size={22} />
        <span className="flex-1">
          <span className="block text-[16px] font-semibold underline decoration-link/40 underline-offset-[3px]">
            Generate a quest near me
          </span>
          <span className="block text-[13px] text-muted">Gemma writes a case from facts fetched near you, or in a city you pick.</span>
        </span>
        <ArrowRightIcon size={18} />
      </Link>
    </Screen>
  );
}
