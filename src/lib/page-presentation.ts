/**
 * Per-page presentation settings (scope expansion 2026-10-01): font, small
 * text and full width. Stored on the page row and shared by every member;
 * only Owner/Editor can change them. Enum and booleans only — never CSS.
 *
 * Pure module shared by the server (validation, DB CHECK) and the UI.
 */

export const PAGE_FONTS = ["default", "serif", "mono"] as const;
export type PageFont = (typeof PAGE_FONTS)[number];

export const PAGE_FONT_LABEL: Readonly<Record<PageFont, string>> = {
  default: "Default",
  serif: "Serif",
  mono: "Mono",
};

export interface PagePresentation {
  font: PageFont;
  smallText: boolean;
  fullWidth: boolean;
}

export const DEFAULT_PAGE_PRESENTATION: Readonly<PagePresentation> = Object.freeze({
  font: "default",
  smallText: false,
  fullWidth: false,
});

export function isPageFont(value: unknown): value is PageFont {
  return typeof value === "string" && (PAGE_FONTS as readonly string[]).includes(value);
}
