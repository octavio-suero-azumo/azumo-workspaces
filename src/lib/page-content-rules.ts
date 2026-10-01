/**
 * Page content rules shared by the editor (client) and the server-side
 * validation (PR2, T-11). No imports: safe for client and server bundles.
 *
 * The editor is Tiptap StarterKit with `link` disabled (hrefs are an XSS
 * surface and links are not in scope) and headings limited to H1–H3 (the
 * toolbar levels). `tests/unit/page-content.test.ts` checks that these lists
 * are exactly the node types, marks and attributes of the schema the editor
 * builds, so the server accepts everything the editor can produce and nothing
 * else.
 */

export const PAGE_TITLE_MAX = 200;

/** Serialized content limit (UTF-8 bytes of the JSON document). */
export const PAGE_CONTENT_MAX_BYTES = 200 * 1024;

/**
 * Maximum JSON nesting depth (objects + arrays). Each node level costs two
 * (the `content` array and the node object), so this allows ~50 node levels.
 * Checked iteratively before any recursive processing.
 */
export const PAGE_CONTENT_MAX_DEPTH = 100;

export const PAGE_HEADING_LEVELS = [1, 2, 3] as const;

export const PAGE_NODE_TYPES = [
  "doc",
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
] as const;
export type PageNodeType = (typeof PAGE_NODE_TYPES)[number];

export const PAGE_MARK_TYPES = ["bold", "italic", "strike", "code", "underline"] as const;
export type PageMarkType = (typeof PAGE_MARK_TYPES)[number];

/** Attributes each node type may carry (none for the others). */
export const PAGE_NODE_ATTRS: Readonly<Record<PageNodeType, readonly string[]>> = Object.freeze({
  doc: [],
  paragraph: [],
  text: [],
  heading: ["level"],
  bulletList: [],
  orderedList: ["start", "type"],
  listItem: [],
  blockquote: [],
  codeBlock: ["language"],
  hardBreak: [],
  horizontalRule: [],
});
