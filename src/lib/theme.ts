/**
 * Appearance preference (scope expansion 2026-10-01): Light / Dark / System.
 *
 * Stored per DEVICE in a first-party cookie, so the root layout can render
 * `<html data-theme>` on the server and the first paint already has the right
 * colors (no flash, no inline script). It holds only this visual preference —
 * never content, permissions or events.
 */

export const THEME_COOKIE = "azumo-theme";
export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];

export const THEME_LABEL: Readonly<Record<ThemePreference, string>> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Unknown or missing values fall back to following the OS ("system"). */
export function parseTheme(value: unknown): ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as ThemePreference)
    : "system";
}

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
