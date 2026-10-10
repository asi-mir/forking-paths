"use client";

import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { CitedFact, SpokenLine } from "@/quest/api";
import type { Narrator, NarratorState } from "@/play/audio";
import { SOURCE_LABEL, hostOf } from "@/play/labels";
import { ExternalIcon, PlayIcon, StopIcon } from "./icons";

// ---------------------------------------------------------------------------
// Layout

/** One column, 20 px gutters, the primary action anchored at the bottom (thumb zone). */
export function Screen({
  top,
  children,
  actions,
  tone = "paper",
}: {
  top?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "paper" | "pocket";
}) {
  const pocket = tone === "pocket";
  return (
    <div
      className={`flex min-h-dvh flex-1 flex-col overflow-x-clip ${pocket ? "bg-pocket text-pocket-ink" : "text-ink"}`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col px-5">
        {top ? <header className="flex min-h-12 items-center justify-between gap-3 pt-3">{top}</header> : null}
        <main className="flex flex-1 flex-col pb-6">{children}</main>
      </div>
      {actions ? (
        <div
          className={`sticky bottom-0 z-10 ${pocket ? "bg-pocket" : "bg-paper/95 backdrop-blur-sm"}`}
          style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
        >
          <div
            className={`mx-auto flex w-full max-w-[440px] flex-col gap-2.5 px-5 pt-3 ${pocket ? "" : "border-t border-rule"}`}
          >
            {actions}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The case-file header line: "CASE 4F2A · STOP 2 OF 3". */
export function TopBar({ left, right, tone = "paper" }: { left: ReactNode; right?: ReactNode; tone?: "paper" | "pocket" }) {
  const color = tone === "pocket" ? "!text-pocket-muted" : "";
  return (
    <>
      <span className={`label ${color}`}>{left}</span>
      {right ? <span className={`label ${color}`}>{right}</span> : null}
    </>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`label ${className}`}>{children}</p>;
}

// ---------------------------------------------------------------------------
// Buttons (≥ 56 px tall)

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  type?: "button" | "submit";
  tone?: "paper" | "pocket";
  testId?: string;
};

/** The one primary action of a screen: stamp red. */
export function PrimaryButton({ children, onClick, disabled, icon, type = "button", testId }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="flex min-h-14 w-full items-center justify-center gap-2.5 rounded-[10px] bg-stamp px-5 text-[17px] font-semibold tracking-[0.01em] text-stamp-ink shadow-[0_1px_0_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.12)] transition active:translate-y-px active:brightness-95 disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled, icon, tone = "paper", testId }: ButtonProps) {
  const colors =
    tone === "pocket"
      ? "border-pocket-ink/30 text-pocket-ink active:bg-pocket-ink/10"
      : "border-ink/25 text-ink active:bg-ink/5";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`flex min-h-14 w-full items-center justify-center gap-2.5 rounded-[10px] border-[1.5px] px-5 text-[16px] font-medium transition disabled:opacity-50 ${colors}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** A file input styled as the primary button: opens the native camera on phones. */
export function CameraButton({
  children,
  onPick,
  onOpen,
  icon,
  testId,
}: {
  children: ReactNode;
  onPick: (file: File) => void;
  onOpen?: () => void;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <label className="relative flex min-h-14 w-full cursor-pointer items-center justify-center gap-2.5 rounded-[10px] bg-stamp px-5 text-[17px] font-semibold text-stamp-ink shadow-[0_1px_0_rgb(0_0_0/0.25)] focus-within:outline focus-within:outline-[2.5px] focus-within:outline-offset-[3px] focus-within:outline-link active:translate-y-px">
      {icon}
      {children}
      <input
        data-testid={testId}
        type="file"
        accept="image/*"
        capture="environment"
        className="absolute inset-0 cursor-pointer opacity-0"
        onClick={onOpen}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Stamp

export function Stamp({
  children,
  tone = "ink",
  rotate = -8,
  className = "",
}: {
  children: ReactNode;
  tone?: "ink" | "red" | "muted";
  rotate?: number;
  className?: string;
}) {
  const color = tone === "red" ? "text-stamp border-stamp" : tone === "muted" ? "text-muted border-muted" : "text-ink border-ink";
  return (
    <span
      className={`stamp-in inline-block rounded-[6px] border-[3px] px-3 py-1 font-mono text-[22px] font-semibold uppercase leading-none tracking-[0.18em] ${color} ${className}`}
      style={{ ["--stamp-rot" as string]: `${rotate}deg`, transform: `rotate(${rotate}deg)`, mixBlendMode: "multiply" }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The narrator

export const NarratorContext = createContext<Narrator | null>(null);

const idle: NarratorState = { playing: null, ambience: false };
const noSubscribe = () => () => undefined;

export function useNarratorState(): NarratorState {
  const n = useContext(NarratorContext);
  return useSyncExternalStore(
    n?.subscribe ?? noSubscribe,
    n?.getState ?? (() => idle),
    () => idle,
  );
}

/**
 * A narrator line: a large quote, always readable (the caption), with a small play
 * control when the line has a clip. Without a clip the text alone is the line.
 */
export function Narration({
  line,
  label,
  size = "lg",
  withAmbience = false,
  tag,
  onPlay,
  tone = "paper",
  testId,
}: {
  line: SpokenLine;
  label?: ReactNode;
  size?: "xl" | "lg" | "md";
  withAmbience?: boolean;
  tag?: string;
  onPlay?: () => void;
  tone?: "paper" | "pocket";
  testId?: string;
}) {
  const narrator = useContext(NarratorContext);
  const state = useNarratorState();
  const playing = line.clipId !== undefined && state.playing === line.clipId;
  const text = size === "xl" ? "text-[30px] leading-[1.22]" : size === "lg" ? "text-[25px] leading-[1.32]" : "text-[20px] leading-[1.4]";
  const muted = tone === "pocket" ? "text-pocket-muted" : "text-muted";

  const toggle = () => {
    if (!narrator || !line.clipId) return;
    if (playing) {
      narrator.stopLine();
      return;
    }
    onPlay?.();
    narrator.unlock(); // in the tap itself: iOS lets an element play only after a tap started it
    void narrator.play(line.clipId, { withAmbience, tag });
  };

  return (
    <figure className="rise" data-testid={testId}>
      {label ? <figcaption className={`label mb-3 ${tone === "pocket" ? "!text-pocket-muted" : ""}`}>{label}</figcaption> : null}
      <blockquote className={`narration relative pl-6 font-[420] ${text}`}>
        <span aria-hidden className={`absolute -left-0.5 -top-1.5 font-serif text-[44px] leading-none ${muted}`}>
          &ldquo;
        </span>
        {line.text}
      </blockquote>
      <div className="mt-4 flex min-h-11 items-center gap-3 pl-6">
        {line.clipId && narrator ? (
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Stop the narrator" : "Play the narrator"}
            data-testid={testId ? `${testId}-play` : undefined}
            className={`flex h-11 items-center gap-2 rounded-full border-[1.5px] pl-3 pr-4 text-[14px] font-medium transition ${
              tone === "pocket" ? "border-pocket-ink/35 text-pocket-ink" : "border-ink/30 text-ink active:bg-ink/5"
            }`}
          >
            {playing ? <StopIcon size={16} /> : <PlayIcon size={16} />}
            <span>{playing ? "Stop" : "Listen"}</span>
            {playing ? <Bars /> : null}
          </button>
        ) : (
          <span className={`label ${tone === "pocket" ? "!text-pocket-muted" : ""}`}>Text only</span>
        )}
      </div>
    </figure>
  );
}

function Bars() {
  return (
    <span aria-hidden className="ml-1 flex h-3.5 items-end gap-[3px]">
      {[0, 0.2, 0.4].map((d) => (
        <span key={d} className="bar block h-full w-[3px] rounded-full bg-current" style={{ animationDelay: `${d}s` }} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Facts

export function SourceChip({ source }: { source: CitedFact["source"] }) {
  return (
    <span className="inline-flex items-center rounded-full border border-ink/25 bg-paper px-2.5 py-1 font-mono text-[11px] font-medium leading-none tracking-[0.04em] text-ink">
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** A fact with where it came from: the source, the exact query and the link. */
export function FactCard({ fact }: { fact: CitedFact }) {
  return (
    <article className="rounded-[10px] border border-rule bg-card p-4 shadow-[0_1px_0_rgb(28_26_23/0.06)]" data-testid="fact">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <SourceChip source={fact.source} />
        <span className="font-mono text-[11px] text-muted">{fact.id}</span>
      </div>
      <p className="text-[15.5px] leading-[1.55] text-ink">{fact.text}</p>
      <p className="mt-3 break-words font-mono text-[12px] leading-[1.5] text-muted">
        <span className="select-none">query </span>
        <span className="text-ink">&ldquo;{fact.query}&rdquo;</span>
      </p>
      <a
        href={fact.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2.5 inline-flex min-h-11 max-w-full items-center gap-1.5 text-[15px] font-medium text-link underline decoration-link/40 underline-offset-[3px]"
      >
        <span className="truncate">{fact.sourceTitle}</span>
        <ExternalIcon size={15} className="shrink-0" />
        <span className="sr-only">({hostOf(fact.url)})</span>
      </a>
    </article>
  );
}

export function FactList({ facts, label = "Where this comes from" }: { facts: CitedFact[]; label?: string }) {
  if (facts.length === 0) return null;
  return (
    <section className="mt-6">
      <Label className="mb-3">{label}</Label>
      <div className="flex flex-col gap-3">
        {facts.map((f) => (
          <FactCard key={f.id} fact={f} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Photos

/** A photo pinned to the file: white border, a strip of tape. */
export function Snapshot({
  src,
  caption,
  rotate = -1.5,
  className = "",
}: {
  src: string;
  caption?: ReactNode;
  rotate?: number;
  className?: string;
}) {
  return (
    <figure
      className={`relative bg-receipt p-2 pb-3 shadow-[0_2px_10px_rgb(28_26_23/0.16)] ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <span aria-hidden className="absolute -top-2.5 left-1/2 h-5 w-16 -translate-x-1/2 rotate-[2deg] bg-paper-deep/80 shadow-sm" />
      {/* eslint-disable-next-line @next/next/no-img-element -- a local blob URL from this phone */}
      <img src={src} alt="" className="aspect-[4/3] w-full object-cover" />
      {caption ? <figcaption className="mt-2 px-0.5 font-mono text-[11px] leading-snug text-muted">{caption}</figcaption> : null}
    </figure>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-[10px] border-[1.5px] border-stamp/50 bg-card px-4 py-3 text-[15px] leading-snug text-ink">
      {children}
    </p>
  );
}
