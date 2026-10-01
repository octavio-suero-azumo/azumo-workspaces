import { z } from "zod";
import {
  PAGE_CONTENT_MAX_BYTES,
  PAGE_CONTENT_MAX_DEPTH,
  PAGE_HEADING_LEVELS,
  PAGE_MARK_TYPES,
  type PageMarkType,
} from "@/lib/page-content-rules";
import { ValidationError } from "@/server/errors";

/**
 * Server-side validation of page content (PR2, T-11, AC-30).
 *
 * Page content is a Tiptap StarterKit JSON document stored in `page.content`
 * (jsonb). It is never HTML: the editor renders it through its schema, and no
 * view injects raw HTML (tests/unit/no-raw-html.test.ts). The server accepts only:
 *
 * - a plain object `{ type: "doc", content: [...] }` (a string, HTML or JSON,
 *   is rejected);
 * - the node types, marks and attributes of the editor's schema
 *   (`src/lib/page-content-rules.ts`); every object is strict, so unknown
 *   types, unknown keys and raw HTML strings in place of nodes are rejected;
 * - at most `PAGE_CONTENT_MAX_BYTES` serialized and `PAGE_CONTENT_MAX_DEPTH`
 *   nested levels. Depth is checked iteratively BEFORE serializing or running
 *   the recursive schema, so hostile nesting cannot exhaust the stack.
 *
 * Text is stored verbatim: `<script>` typed by a user is text, rendered as
 * text (escaped) by the editor.
 */

export interface PageMark {
  type: PageMarkType;
  attrs?: Record<string, never>;
}

export interface PageTextNode {
  type: "text";
  text: string;
  marks?: PageMark[];
}

export interface PageHardBreakNode {
  type: "hardBreak";
  attrs?: Record<string, never>;
  marks?: PageMark[];
}

export type PageInlineNode = PageTextNode | PageHardBreakNode;

export interface PageParagraphNode {
  type: "paragraph";
  attrs?: Record<string, never>;
  content?: PageInlineNode[];
}

export interface PageHeadingNode {
  type: "heading";
  attrs?: { level: (typeof PAGE_HEADING_LEVELS)[number] };
  content?: PageInlineNode[];
}

export interface PageBlockquoteNode {
  type: "blockquote";
  attrs?: Record<string, never>;
  content: PageBlockNode[];
}

export interface PageListItemNode {
  type: "listItem";
  attrs?: Record<string, never>;
  content: PageBlockNode[];
}

export interface PageBulletListNode {
  type: "bulletList";
  attrs?: Record<string, never>;
  content: PageListItemNode[];
}

export interface PageOrderedListNode {
  type: "orderedList";
  attrs?: { start?: number; type?: OrderedListType | null };
  content: PageListItemNode[];
}

export interface PageCodeBlockNode {
  type: "codeBlock";
  attrs?: { language?: string | null };
  content?: Array<{ type: "text"; text: string }>;
}

export interface PageHorizontalRuleNode {
  type: "horizontalRule";
  attrs?: Record<string, never>;
}

export type PageBlockNode =
  | PageParagraphNode
  | PageHeadingNode
  | PageBlockquoteNode
  | PageBulletListNode
  | PageOrderedListNode
  | PageCodeBlockNode
  | PageHorizontalRuleNode;

export interface PageDoc {
  type: "doc";
  content: PageBlockNode[];
}

const ORDERED_LIST_TYPES = ["1", "a", "A", "i", "I"] as const;
type OrderedListType = (typeof ORDERED_LIST_TYPES)[number];

const noAttrs = z.strictObject({}).optional() as z.ZodType<Record<string, never> | undefined>;

const mark: z.ZodType<PageMark> = z.strictObject({
  type: z.enum(PAGE_MARK_TYPES),
  attrs: noAttrs,
});

const marks = z
  .array(mark)
  .max(PAGE_MARK_TYPES.length)
  .refine((list) => new Set(list.map((m) => m.type)).size === list.length, { message: "Duplicate mark." });

const text: z.ZodType<PageTextNode> = z.strictObject({
  type: z.literal("text"),
  // ProseMirror never produces empty text nodes.
  text: z.string().min(1),
  marks: marks.optional(),
});

const hardBreak: z.ZodType<PageHardBreakNode> = z.strictObject({
  type: z.literal("hardBreak"),
  attrs: noAttrs,
  marks: marks.optional(),
});

const inline: z.ZodType<PageInlineNode> = z.union([text, hardBreak]);

// Code blocks hold unmarked text only (StarterKit `codeBlock` allows no marks).
const plainText = z.strictObject({ type: z.literal("text"), text: z.string().min(1) });

const paragraph: z.ZodType<PageParagraphNode> = z.strictObject({
  type: z.literal("paragraph"),
  attrs: noAttrs,
  content: z.array(inline).optional(),
});

const heading: z.ZodType<PageHeadingNode> = z.strictObject({
  type: z.literal("heading"),
  attrs: z.strictObject({ level: z.literal(PAGE_HEADING_LEVELS) }).optional(),
  content: z.array(inline).optional(),
});

const codeBlock: z.ZodType<PageCodeBlockNode> = z.strictObject({
  type: z.literal("codeBlock"),
  attrs: z
    .strictObject({
      language: z
        .string()
        .max(50)
        .regex(/^[A-Za-z0-9_+#.-]*$/)
        .nullable()
        .optional(),
    })
    .optional(),
  content: z.array(plainText).optional(),
});

const horizontalRule: z.ZodType<PageHorizontalRuleNode> = z.strictObject({
  type: z.literal("horizontalRule"),
  attrs: noAttrs,
});

// Recursive part: block containers. `z.lazy` defers the references; the
// iterative depth check in `parsePageContent` bounds the recursion.
const block: z.ZodType<PageBlockNode> = z.lazy(() =>
  z.union([paragraph, heading, blockquote, bulletList, orderedList, codeBlock, horizontalRule]),
);

const listItem: z.ZodType<PageListItemNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal("listItem"),
    attrs: noAttrs,
    content: z.array(block).min(1),
  }),
);

const blockquote: z.ZodType<PageBlockquoteNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal("blockquote"),
    attrs: noAttrs,
    content: z.array(block).min(1),
  }),
);

const bulletList: z.ZodType<PageBulletListNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal("bulletList"),
    attrs: noAttrs,
    content: z.array(listItem).min(1),
  }),
);

const orderedList: z.ZodType<PageOrderedListNode> = z.lazy(() =>
  z.strictObject({
    type: z.literal("orderedList"),
    attrs: z
      .strictObject({
        start: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        type: z.enum(ORDERED_LIST_TYPES).nullable().optional(),
      })
      .optional(),
    content: z.array(listItem).min(1),
  }),
);

/** The whole document. `content` may be empty (a page with no content yet). */
export const pageDocSchema: z.ZodType<PageDoc> = z.strictObject({
  type: z.literal("doc"),
  content: z.array(block),
});

export const CONTENT_NOT_A_DOCUMENT_MESSAGE = "Page content must be an editor document.";
export const CONTENT_TOO_LARGE_MESSAGE = `Page content is too large (maximum ${PAGE_CONTENT_MAX_BYTES / 1024} KB).`;
export const CONTENT_TOO_DEEP_MESSAGE = "Page content is nested too deeply.";
export const CONTENT_INVALID_MESSAGE = "Page content contains unsupported elements.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Iterative (no recursion) nesting check over objects and arrays. Returns
 * false as soon as the limit is exceeded, which also stops cyclic structures.
 */
function withinDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof current !== "object" || current === null) continue;
    if (depth > maxDepth) return false;
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) {
      if (typeof child === "object" && child !== null) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Validate untrusted page content. Returns the validated document or throws
 * `ValidationError` (400) with a safe message. Never throws anything else for
 * any JSON-like input.
 */
export function parsePageContent(raw: unknown): PageDoc {
  if (!isPlainObject(raw)) {
    throw new ValidationError(CONTENT_NOT_A_DOCUMENT_MESSAGE);
  }
  if (!withinDepth(raw, PAGE_CONTENT_MAX_DEPTH)) {
    throw new ValidationError(CONTENT_TOO_DEEP_MESSAGE);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new ValidationError(CONTENT_NOT_A_DOCUMENT_MESSAGE);
  }
  if (utf8Length(serialized) > PAGE_CONTENT_MAX_BYTES) {
    throw new ValidationError(CONTENT_TOO_LARGE_MESSAGE);
  }
  const result = pageDocSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(raw.type === "doc" ? CONTENT_INVALID_MESSAGE : CONTENT_NOT_A_DOCUMENT_MESSAGE);
  }
  return result.data;
}
