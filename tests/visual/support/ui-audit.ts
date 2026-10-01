/**
 * In-page UI audit for the visual baseline (QA, 2026-10-01). TEST-ONLY.
 *
 * `auditPage` and `readActiveElement` are serialized by Playwright and run
 * inside the page, so they must not reference anything outside their own
 * bodies. They only READ the DOM and computed styles; the page is not changed
 * (the focus reader keeps a WeakMap on `window`, never touches the DOM).
 *
 * Heuristics and their limits:
 * - Colours are resolved through a 1×1 canvas (handles oklch/lab/color-mix).
 *   Alpha and `opacity` are composited over the painted ancestor backgrounds,
 *   with white as the canvas colour. Background images/gradients are ignored.
 * - Text contrast uses the WCAG 2.x 1.4.3 thresholds: 4.5:1, or 3:1 for text
 *   of at least 24px, or 18.66px bold. Disabled controls are reported but
 *   flagged, because inactive components are exempt.
 * - Control boundaries use 1.4.11 (3:1) for inputs, selects, textareas, buttons
 *   and contenteditable regions that have no contrasting fill.
 */

export type Region = "aside" | "main" | "other";

export interface ElementRef {
  el: string;
  region: Region;
  text: string;
}

export interface ContrastIssue extends ElementRef {
  kind: "text" | "placeholder";
  ratio: number;
  required: number;
  fg: string;
  bg: string;
  fontSizePx: number;
  fontWeight: number;
  disabled: boolean;
}

export interface BoundaryIssue extends ElementRef {
  ratio: number;
  border: string | null;
  backdrop: string;
  disabled: boolean;
}

export interface BoxRef extends ElementRef {
  left: number;
  right: number;
  width: number;
  scrollWidth?: number;
  clientWidth?: number;
}

export interface PageAudit {
  title: string;
  lang: string | null;
  viewportMeta: string | null;
  htmlAttributes: Record<string, string>;
  colorScheme: { computed: string; prefersDark: boolean; bodyFg: string; bodyBg: string };
  scroll: {
    docScrollWidth: number;
    docClientWidth: number;
    bodyScrollWidth: number;
    innerWidth: number;
    horizontalOverflowPx: number;
    scrollXAfterScrollAttempt: number;
    docScrollHeight: number;
  };
  layout: { asideWidth: number | null; mainWidth: number | null; mainContentRightEdge: number | null };
  overflow: { viewportOffenders: BoxRef[]; spilling: BoxRef[]; truncated: BoxRef[] };
  contrast: {
    textChecked: number;
    textIssues: ContrastIssue[];
    placeholderIssues: ContrastIssue[];
    boundaryChecked: number;
    boundaryIssues: BoundaryIssue[];
  };
  headings: Array<{ level: number; text: string; region: Region; inPageContent: boolean }>;
  landmarks: { main: number; navLabels: Array<string | null>; asideLabels: Array<string | null>; firstLinkIsSkipLink: boolean };
  dialogs: number;
  expandableControls: number;
  aiTextMatches: string[];
  devOverlayPresent: boolean;
}

export function auditPage(): PageAudit {
  type RGB = { r: number; g: number; b: number };
  type RGBA = RGB & { a: number };

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("ui-audit: no 2d canvas context");

  const parse = (css: string): RGBA => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const blend = (top: RGB, alpha: number, bottom: RGB): RGB => ({
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  });
  const hex = (c: RGB | null): string =>
    c === null
      ? "none"
      : `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c: RGB) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a: RGB, b: RGB) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const round2 = (v: number) => Math.round(v * 100) / 100;

  const opacityOf = (el: Element | null): number => {
    let value = 1;
    for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  /** The colour painted behind `el`'s content: its own background over its ancestors'. */
  const backdropOf = (el: Element): RGB => {
    const chain: Element[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
    let color: RGB = { r: 255, g: 255, b: 255 };
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const bg = parse(getComputedStyle(chain[i]).backgroundColor);
      if (bg.a > 0) color = blend(bg, bg.a * opacityOf(chain[i]), color);
    }
    return color;
  };
  const isVisible = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility !== "visible") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && opacityOf(el) > 0;
  };
  const regionOf = (el: Element): Region => (el.closest("aside") ? "aside" : el.closest("main") ? "main" : "other");
  const describe = (el: Element) => {
    let label = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    const role = el.getAttribute("role");
    const aria = el.getAttribute("aria-label");
    const type = el.getAttribute("type");
    if (type && label === "input") label += `[type=${type}]`;
    if (testId) label += `[data-testid=${testId}]`;
    if (role) label += `[role=${role}]`;
    if (aria) label += `[aria-label="${aria}"]`;
    return { el: label, region: regionOf(el), text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) };
  };
  const isDisabled = (el: Element) => el.matches(":disabled") || el.closest("button:disabled, fieldset:disabled") !== null;
  const ownText = (el: Element) =>
    Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);

  window.scrollTo(0, 0);
  const root = document.documentElement;
  const all = Array.from(document.body.querySelectorAll("*")).filter((el) => !el.closest("nextjs-portal"));
  const visible = all.filter(isVisible);

  // --- horizontal scroll ----------------------------------------------------
  const docClientWidth = root.clientWidth;
  window.scrollTo(100_000, 0);
  const scrollXAfterScrollAttempt = window.scrollX;
  window.scrollTo(0, 0);

  // --- overflow ---------------------------------------------------------------
  const outside = (rect: DOMRect) => rect.right > docClientWidth + 1 || rect.left < -1;
  const viewportOffenders = visible
    .filter((el) => outside(el.getBoundingClientRect()))
    .filter((el) => !el.parentElement || !outside(el.parentElement.getBoundingClientRect()))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return { ...describe(el), left: round2(rect.left), right: round2(rect.right), width: round2(rect.width) };
    });
  // Inline boxes report clientWidth 0, so only boxes with a measurable width count.
  const spilling = visible
    .filter((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "visible" && cs.textOverflow !== "ellipsis";
    })
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        ...describe(el),
        left: round2(rect.left),
        right: round2(rect.right),
        width: round2(rect.width),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });
  const truncated = visible
    .filter((el) => getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        ...describe(el),
        left: round2(rect.left),
        right: round2(rect.right),
        width: round2(rect.width),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    });

  // --- text contrast (1.4.3) ------------------------------------------------
  let textChecked = 0;
  const textIssues: ContrastIssue[] = [];
  for (const el of visible) {
    if (!ownText(el)) continue;
    const cs = getComputedStyle(el);
    const bg = backdropOf(el);
    const fgRaw = parse(cs.color);
    const fg = blend(fgRaw, fgRaw.a * opacityOf(el), bg);
    const ratio = contrast(fg, bg);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    textChecked += 1;
    if (ratio < required) {
      textIssues.push({
        ...describe(el),
        kind: "text",
        ratio: round2(ratio),
        required,
        fg: hex(fg),
        bg: hex(bg),
        fontSizePx: size,
        fontWeight: weight,
        disabled: isDisabled(el),
      });
    }
  }
  const placeholderIssues: ContrastIssue[] = [];
  for (const el of visible.filter((node) => node.matches("input[placeholder], textarea[placeholder]"))) {
    const placeholderStyle = getComputedStyle(el, "::placeholder");
    const bg = backdropOf(el);
    const fgRaw = parse(placeholderStyle.color);
    const fg = blend(fgRaw, fgRaw.a * opacityOf(el), bg);
    const ratio = contrast(fg, bg);
    const size = parseFloat(placeholderStyle.fontSize);
    const weight = Number(placeholderStyle.fontWeight) || 400;
    const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (ratio < required) {
      placeholderIssues.push({
        ...describe(el),
        text: el.getAttribute("placeholder") ?? "",
        kind: "placeholder",
        ratio: round2(ratio),
        required,
        fg: hex(fg),
        bg: hex(bg),
        fontSizePx: size,
        fontWeight: weight,
        disabled: isDisabled(el),
      });
    }
  }

  // --- control boundaries (1.4.11) -------------------------------------------
  let boundaryChecked = 0;
  const boundaryIssues: BoundaryIssue[] = [];
  const controls = visible.filter((el) =>
    el.matches('input:not([type="hidden"]):not([type="file"]), select, textarea, button, [contenteditable]'),
  );
  for (const el of controls) {
    const cs = getComputedStyle(el);
    const outer = el.parentElement ? backdropOf(el.parentElement) : { r: 255, g: 255, b: 255 };
    const fillRaw = parse(cs.backgroundColor);
    const fill = fillRaw.a > 0 ? blend(fillRaw, fillRaw.a * opacityOf(el), outer) : null;
    const fillContrast = fill ? contrast(fill, outer) : 1;
    const borderWidth = parseFloat(cs.borderTopWidth);
    const borderRaw = parse(cs.borderTopColor);
    const border =
      borderWidth > 0 && cs.borderTopStyle !== "none" && borderRaw.a > 0 ? blend(borderRaw, borderRaw.a * opacityOf(el), outer) : null;
    const borderContrast = border ? contrast(border, outer) : 1;
    boundaryChecked += 1;
    const best = Math.max(fillContrast, borderContrast);
    if (best < 3) {
      boundaryIssues.push({ ...describe(el), ratio: round2(best), border: hex(border), backdrop: hex(outer), disabled: isDisabled(el) });
    }
  }

  // --- structure ----------------------------------------------------------------
  const headings = visible
    .filter((el) => /^H[1-6]$/.test(el.tagName))
    .map((el) => ({
      level: Number(el.tagName.slice(1)),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      region: regionOf(el),
      inPageContent: el.closest('[aria-label="Page content"]') !== null,
    }));
  const firstLink = document.querySelector("a[href]");
  const main = document.querySelector("main");
  const aside = document.querySelector("aside");
  const mainContentRightEdge = main
    ? Math.max(
        0,
        ...Array.from(main.querySelectorAll("*"))
          .filter(isVisible)
          .map((el) => el.getBoundingClientRect().right),
      )
    : null;

  // --- AI UI scan (expected: none) ----------------------------------------------
  const AI_PATTERN = /\b(AI|A\.I\.|GPT|LLM|Copilot|Assistant|Ask AI|Generate|Summari[sz]e|Autocomplete|Magic)\b|✨/i;
  const aiTextMatches: string[] = [];
  const bodyText = document.body.innerText;
  for (const line of bodyText.split(/\n+/)) {
    if (AI_PATTERN.test(line)) aiTextMatches.push(`text: ${line.trim().slice(0, 80)}`);
  }
  for (const el of all) {
    for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
      const value = el.getAttribute(attr);
      if (value && AI_PATTERN.test(value)) aiTextMatches.push(`${attr}: ${value.slice(0, 80)}`);
    }
  }

  const bodyStyle = getComputedStyle(document.body);
  const htmlAttributes: Record<string, string> = {};
  for (const attr of Array.from(root.attributes)) htmlAttributes[attr.name] = attr.value;

  return {
    title: document.title,
    lang: root.getAttribute("lang"),
    viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
    htmlAttributes,
    colorScheme: {
      computed: getComputedStyle(root).colorScheme,
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      bodyFg: hex(parse(bodyStyle.color)),
      bodyBg: hex(backdropOf(document.body)),
    },
    scroll: {
      docScrollWidth: root.scrollWidth,
      docClientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      horizontalOverflowPx: root.scrollWidth - docClientWidth,
      scrollXAfterScrollAttempt,
      docScrollHeight: root.scrollHeight,
    },
    layout: {
      asideWidth: aside ? round2(aside.getBoundingClientRect().width) : null,
      mainWidth: main ? round2(main.getBoundingClientRect().width) : null,
      mainContentRightEdge: mainContentRightEdge === null ? null : round2(mainContentRightEdge),
    },
    overflow: { viewportOffenders, spilling, truncated },
    contrast: { textChecked, textIssues, placeholderIssues, boundaryChecked, boundaryIssues },
    headings,
    landmarks: {
      main: document.querySelectorAll("main").length,
      navLabels: Array.from(document.querySelectorAll("nav")).map((el) => el.getAttribute("aria-label")),
      asideLabels: Array.from(document.querySelectorAll("aside")).map(
        (el) => el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby"),
      ),
      firstLinkIsSkipLink: firstLink !== null && /skip/i.test(firstLink.textContent ?? ""),
    },
    dialogs: document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]').length,
    expandableControls: document.querySelectorAll("[aria-expanded]").length,
    aiTextMatches,
    devOverlayPresent: document.querySelector("nextjs-portal") !== null,
  };
}

export interface ActiveElementInfo {
  id: number;
  seen: boolean;
  devOverlay: boolean;
  el: string;
  region: Region;
  text: string;
  focusVisible: boolean;
  indicator: boolean;
  outline: string;
  boxShadow: string;
  inViewport: boolean;
}

/** The focused element (null when focus is on the body/document). Read-only. */
export function readActiveElement(): ActiveElementInfo | null {
  const w = window as unknown as { __qaFocusIds?: WeakMap<Element, number>; __qaFocusNext?: number };
  const ids = w.__qaFocusIds ?? new WeakMap<Element, number>();
  w.__qaFocusIds = ids;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  let id = ids.get(el);
  const seen = id !== undefined;
  if (id === undefined) {
    id = w.__qaFocusNext ?? 0;
    w.__qaFocusNext = id + 1;
    ids.set(el, id);
  }
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  let label = el.tagName.toLowerCase();
  const testId = el.getAttribute("data-testid");
  const aria = el.getAttribute("aria-label");
  const type = el.getAttribute("type");
  if (type && label === "input") label += `[type=${type}]`;
  if (testId) label += `[data-testid=${testId}]`;
  if (aria) label += `[aria-label="${aria}"]`;
  const outlineVisible = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  return {
    id,
    seen,
    devOverlay: el.tagName === "NEXTJS-PORTAL",
    el: label,
    region: el.closest("aside") ? "aside" : el.closest("main") ? "main" : "other",
    text: (el.textContent || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 50),
    focusVisible: el.matches(":focus-visible"),
    indicator: outlineVisible || cs.boxShadow !== "none",
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
    boxShadow: cs.boxShadow,
    inViewport: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
  };
}
