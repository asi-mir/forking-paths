"use client";

import { useSyncExternalStore } from "react";
import type { RunState } from "./run-state";

/**
 * Walk records in localStorage (key fp:run:<runId>), read through useSyncExternalStore so a
 * reload, a lock or another tab sees the same walk. The server render sees no record.
 */

const key = (runId: string) => `fp:run:${runId}`;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: RunState | null }>();

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function readRun(runId: string): RunState | null {
  const raw = safeGet(key(runId));
  const hit = cache.get(runId);
  if (hit && hit.raw === raw) return hit.value;
  let value: RunState | null = null;
  try {
    const parsed = raw ? (JSON.parse(raw) as RunState) : null;
    value = parsed?.v === 1 ? parsed : null;
  } catch {
    value = null;
  }
  cache.set(runId, { raw, value });
  return value;
}

export function writeRun(state: RunState) {
  try {
    localStorage.setItem(key(state.runId), JSON.stringify(state));
    localStorage.setItem("fp:last-run", state.runId);
  } catch {
    // Storage full or blocked: the walk still works until the page reloads.
    cache.set(state.runId, { raw: JSON.stringify(state), value: state });
  }
  listeners.forEach((fn) => fn());
}

export function updateRun(runId: string, fn: (s: RunState) => RunState) {
  const current = readRun(runId);
  if (current) writeRun(fn(current));
}

export function lastRunId(): string | null {
  return safeGet("fp:last-run");
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith("fp:run:")) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** The walk record, or null (not on this phone), or undefined while the server renders. */
export function useRun(runId: string): RunState | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => readRun(runId),
    () => undefined,
  );
}

const noop = () => () => undefined;

/** True after hydration (false during the server render). */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
