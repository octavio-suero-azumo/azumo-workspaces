/**
 * Page documents for tests (PR2, AC-29, AC-30). Every document is passed
 * through the REAL editor schema (`pageEditorExtensions` → ProseMirror
 * `nodeFromJSON(...).toJSON()`), so it is exactly what the editor would
 * serialize, not a hand-written approximation.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import { pageEditorExtensions } from "@/lib/editor/extensions";

export const editorSchema = getSchema(pageEditorExtensions);

/** Normalize through the editor schema and check the content model. */
export function asEditorJson(doc: JSONContent): JSONContent {
  const node = editorSchema.nodeFromJSON(doc);
  node.check();
  return node.toJSON() as JSONContent;
}

const t = (text: string, marks?: string[]): JSONContent =>
  marks ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text };

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

const li = (text: string): JSONContent => ({ type: "listItem", content: [p(t(text))] });

/** AC-29: H1–H3, bold, italic, a bulleted list and a numbered list. */
export function formattedDoc(): JSONContent {
  return asEditorJson({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [t("Heading one")] },
      { type: "heading", attrs: { level: 2 }, content: [t("Heading two")] },
      { type: "heading", attrs: { level: 3 }, content: [t("Heading three")] },
      p(t("Plain "), t("bold", ["bold"]), t(" and "), t("italic", ["italic"]), t(" and "), t("both", ["bold", "italic"])),
      { type: "bulletList", content: [li("bullet one"), li("bullet two")] },
      { type: "orderedList", content: [li("number one"), li("number two")] },
    ],
  });
}

/** Every other StarterKit element the editor can produce (shortcuts, input rules, paste). */
export function everyElementDoc(): JSONContent {
  return asEditorJson({
    type: "doc",
    content: [
      ...(formattedDoc().content ?? []),
      p(t("struck", ["strike"]), t(" "), t("inline code", ["code"]), t(" "), t("underlined", ["underline"])),
      p(t("line one"), { type: "hardBreak" }, t("line two")),
      p(t("bold break", ["bold"]), { type: "hardBreak", marks: [{ type: "bold" }] }, t("after")),
      { type: "blockquote", content: [p(t("quoted"))] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [t("const x = 1;")] },
      { type: "codeBlock", content: [t("plain code")] },
      { type: "horizontalRule" },
      { type: "orderedList", attrs: { start: 3, type: "a" }, content: [li("third")] },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(t("outer")), { type: "bulletList", content: [li("inner")] }] },
        ],
      },
      { type: "paragraph" },
    ],
  });
}

/** AC-30 payloads, typed by a user as TEXT. */
export const XSS_PAYLOADS = [
  "<script>window.__xss = 1; alert('xss')</script>",
  '<img src=x onerror="window.__xss = 1; alert(1)">',
  "\"><svg onload=alert(1)>",
] as const;

export function xssDoc(): JSONContent {
  return asEditorJson({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [t(XSS_PAYLOADS[0])] },
      ...XSS_PAYLOADS.map((payload) => p(t(payload))),
      p(t(XSS_PAYLOADS[1], ["bold"])),
    ],
  });
}
