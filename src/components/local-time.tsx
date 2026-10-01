"use client";

import { useSyncExternalStore } from "react";

/*
 * Dates rendered in the VIEWER's time zone. The server does not know it, so
 * the first render (server and hydration) shows a neutral fallback and the
 * browser formats right after hydrating — no hydration mismatch, no wrong
 * zone. `useSyncExternalStore` gives exactly that: the server snapshot
 * (`null`) during hydration, the browser value afterwards.
 */

const MINUTE_MS = 60_000;

function subscribeNever(): () => void {
  return () => {};
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function subscribeMinute(onChange: () => void): () => void {
  const id = window.setInterval(onChange, 15_000);
  return () => window.clearInterval(id);
}

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS);
}

function serverSnapshot(): null {
  return null;
}

export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(subscribeNever, browserTimeZone, serverSnapshot);
}

/** The browser's current time (epoch ms, floored to the minute; updates every minute), or null before hydration. */
export function useBrowserNow(): number | null {
  const minute = useSyncExternalStore(subscribeMinute, currentMinute, serverSnapshot);
  return minute === null ? null : minute * MINUTE_MS;
}

/** "Edited 3 Oct 2026, 14:05" in the browser's zone (falls back to the UTC date). */
export function LocalDateTime({ iso, prefix }: { iso: string; prefix?: string }) {
  const zone = useBrowserTimeZone();
  const text = zone
    ? new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: zone,
      }).format(new Date(iso))
    : iso.slice(0, 10);
  return (
    <time dateTime={iso} title={zone ? `${text} (${zone})` : undefined}>
      {prefix ? `${prefix} ${text}` : text}
    </time>
  );
}

/** A calendar date (`YYYY-MM-DD`) shown without any time-zone conversion. */
export function formatDateOnly(value: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", ...options, timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
