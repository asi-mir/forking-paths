"use client";

import type { VerdictView } from "@/quest/api";
import { demoSample, type DemoSample, sampleUrl } from "@/quest/demo-samples";
import { CUE_TAG } from "@/play/labels";
import type { RunState } from "@/play/run-state";
import { ArrowRightIcon, CameraIcon, ExternalIcon } from "./icons";
import { Label } from "./ui";

/**
 * Pieces of the desk demo ("Try it from your desk"): sample photo tiles with their credits, the
 * route so far, and what Gemma saw. The walk itself is the normal play screen.
 */

/** "Photo: Francesco Bini, CC BY-SA 4.0, Wikimedia Commons", linked to the file page. */
export function SampleCredit({ sample, className = "" }: { sample: DemoSample; className?: string }) {
  return (
    <p className={`font-mono text-[10.5px] leading-snug text-muted ${className}`} data-testid="sample-credit">
      Photo:{" "}
      <a
        href={sample.filePage}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 text-link underline decoration-link/40 underline-offset-2"
      >
        {sample.author}
        <ExternalIcon size={11} />
      </a>
      , {sample.licence}, Wikimedia Commons{sample.changes.startsWith("Cropped") ? ", cropped" : ""}
    </p>
  );
}

/** The sample photos for this stop, and "Use your own photo". */
export function SamplePicker({
  samples,
  fork,
  disabled,
  onSample,
  onOwnPhoto,
}: {
  samples: DemoSample[];
  fork: boolean;
  disabled?: boolean;
  onSample: (sample: DemoSample) => void;
  onOwnPhoto: (file: File) => void;
}) {
  return (
    <section className="mt-6" data-testid="sample-picker">
      {samples.length > 0 ? (
        <>
          <Label className="mb-2">{fork ? "Pick one detail to photograph" : "A sample photo of this stop"}</Label>
          <div className={`grid gap-3 ${samples.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {samples.map((s) => (
              <figure key={s.id} className="flex flex-col">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSample(s)}
                  data-testid={`sample-${s.id}`}
                  className="group flex flex-col overflow-hidden rounded-[10px] border-[1.5px] border-ink/80 bg-card text-left transition active:translate-y-px disabled:opacity-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a small static sample, shown as is */}
                  <img
                    src={sampleUrl(s)}
                    alt={s.detail}
                    width={s.width}
                    height={s.height}
                    className={`w-full object-cover ${samples.length > 1 ? "aspect-square" : "aspect-[4/3]"}`}
                  />
                  <span className="flex min-h-12 items-center justify-between gap-2 px-3 py-2">
                    <span className="text-[14.5px] font-semibold leading-tight">{s.detail}</span>
                    <ArrowRightIcon size={16} className="shrink-0" />
                  </span>
                </button>
                <figcaption className="mt-1.5 px-0.5">
                  <SampleCredit sample={s} />
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : null}
      <label
        className={`relative mt-4 flex min-h-14 w-full cursor-pointer items-center justify-center gap-2.5 rounded-[10px] border-[1.5px] border-ink/25 px-5 text-[16px] font-medium text-ink focus-within:outline focus-within:outline-[2.5px] focus-within:outline-offset-[3px] focus-within:outline-link active:bg-ink/5 ${disabled ? "pointer-events-none opacity-50" : ""}`}
      >
        <CameraIcon size={20} />
        Use your own photo
        <input
          data-testid="own-photo"
          type="file"
          accept="image/*"
          disabled={disabled}
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onOwnPhoto(file);
          }}
        />
      </label>
      <p className="mt-3 text-[13px] leading-snug text-muted">
        There is no GPS at a desk, so Gemma&apos;s check decides: the photo passes when it looks like it was taken at
        the place.
      </p>
    </section>
  );
}

/** The stops so far, with the detail that picked the way at each fork. */
export function RouteSoFar({ run }: { run: RunState }) {
  if (run.passed.length === 0) return null;
  return (
    <nav aria-label="The route so far" className="mt-4 rounded-[10px] border border-rule bg-card px-3.5 py-2.5" data-testid="route-so-far">
      <p className="label mb-1.5">The route so far</p>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] leading-snug">
        {run.passed.map((p, i) => (
          <li key={p.placeId} className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink font-mono text-[11px] font-semibold text-card">
              {i + 1}
            </span>
            <span className="font-medium">{p.name}</span>
            {p.cue ? <span className="rounded-full border border-ink/30 px-1.5 font-mono text-[11px]">{CUE_TAG[p.cue]}</span> : null}
            <span aria-hidden className="text-muted">
              →
            </span>
          </li>
        ))}
        <li className="font-mono text-[12px] text-muted">stop {run.passed.length + 1}</li>
      </ol>
    </nav>
  );
}

/** The reader's verdict in full, for the desk demo: the cue it matched and how sure it was. */
export function VerdictDetail({ verdict, fork }: { verdict: VerdictView; fork: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11.5px] text-muted" data-testid="verdict-detail">
      {fork ? (
        verdict.cue ? (
          <span>
            matched cue <span className="rounded-full bg-ink px-2 py-0.5 text-paper">{CUE_TAG[verdict.cue]}</span>
          </span>
        ) : (
          <span>no cue matched</span>
        )
      ) : null}
      <span>
        {verdict.plausible ? "taken here" : "not taken here"} · {Math.round(verdict.confidence * 100)}% sure
      </span>
    </div>
  );
}

/** Shown under a stored result: why the screen shows it. */
export function StoredNote() {
  return (
    <p className="mt-2 text-[12.5px] leading-snug text-muted" data-testid="stored-note">
      <span className="label !text-[11px] !text-stamp">Stored result</span> The live model did not answer, so
      this is the saved reading of this sample photo.
    </p>
  );
}

/** The sample sent at a stop, if any. */
export const sentSample = (run: RunState, placeId: string): DemoSample | null => {
  const id = run.samples?.[placeId];
  return id ? demoSample(id) : null;
};
