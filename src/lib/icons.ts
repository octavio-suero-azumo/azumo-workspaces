/**
 * Configurable icons for workspaces and pages (scope expansion 2026-10-01).
 *
 * Icons are chosen from a CURATED emoji allowlist. The server stores the
 * emoji string itself and accepts only values from this list (no HTML, no
 * SVG, no URLs, no free text). `null` in the database means "default icon",
 * which is also how "Reset" is stored.
 *
 * Pure module: no I/O, no `@/` imports (shared by the schema-free server
 * validation and by client components).
 */

export const DEFAULT_WORKSPACE_ICON = "📁";
export const DEFAULT_PAGE_ICON = "📄";

/** The only icon values the server accepts. Order is the picker order. */
export const ICON_CHOICES = [
  "📄", "📝", "📌", "📎", "📁", "🗂️", "📚", "📖",
  "📊", "📈", "📅", "🗓️", "✅", "🎯", "🚀", "💡",
  "⭐", "✨", "🔥", "⚡", "🧭", "🗺️", "🏁", "🧩",
  "🛠️", "⚙️", "🧪", "🔬", "💼", "🏢", "🏠", "🌍",
  "🌱", "🍀", "🎨", "🎵", "🎬", "📷", "💬", "📣",
  "🔔", "🔑", "🎁", "🏆", "💰", "🧾", "📦", "🐞",
  "🤝", "👥", "🙂", "❤️",
] as const;

export type IconChoice = (typeof ICON_CHOICES)[number];

const ICON_SET: ReadonlySet<string> = new Set(ICON_CHOICES);

/** True for exactly one allowlisted emoji string. */
export function isIconChoice(value: unknown): value is IconChoice {
  return typeof value === "string" && ICON_SET.has(value);
}

/** Icon to display: the stored value when valid, otherwise the default. */
export function displayIcon(stored: string | null | undefined, fallback: string): string {
  return isIconChoice(stored) ? stored : fallback;
}
