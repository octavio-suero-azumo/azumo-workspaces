import { describe, expect, it } from "vitest";
import { pageEditorExtensions } from "@/lib/editor/extensions";
import {
  PAGE_CONTENT_MAX_BYTES,
  PAGE_HEADING_LEVELS,
  PAGE_MARK_TYPES,
  PAGE_NODE_ATTRS,
  PAGE_NODE_TYPES,
  type PageNodeType,
} from "@/lib/page-content-rules";
import {
  CONTENT_INVALID_MESSAGE,
  CONTENT_NOT_A_DOCUMENT_MESSAGE,
  CONTENT_TOO_DEEP_MESSAGE,
  CONTENT_TOO_LARGE_MESSAGE,
  parsePageContent,
} from "@/server/data/page-content";
import { ValidationError } from "@/server/errors";
import { editorSchema, everyElementDoc, formattedDoc, xssDoc, XSS_PAYLOADS } from "../support/page-docs";

// T-11 / PR2 / AC-29 / AC-30 (TC-27, TC-28 unit part): server-side content
// validation. The allowlist is checked against the schema the REAL editor
// configuration builds, so the server accepts exactly what the editor can
// produce.

function expectRejected(input: unknown, message?: string) {
  let caught: unknown;
  try {
    parsePageContent(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  if (message) expect((caught as Error).message).toBe(message);
}

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });

describe("the server allowlist equals the editor schema (P7: StarterKit, no link, H1–H3)", () => {
  it("node types", () => {
    expect(Object.keys(editorSchema.nodes).sort()).toEqual([...PAGE_NODE_TYPES].sort());
  });

  it("marks (no link mark: hrefs are never stored)", () => {
    expect(Object.keys(editorSchema.marks).sort()).toEqual([...PAGE_MARK_TYPES].sort());
    expect(Object.keys(editorSchema.marks)).not.toContain("link");
  });

  it("attributes of every node type", () => {
    for (const [name, type] of Object.entries(editorSchema.nodes)) {
      expect({ name, attrs: Object.keys(type.spec.attrs ?? {}).sort() }).toEqual({
        name,
        attrs: [...PAGE_NODE_ATTRS[name as PageNodeType]].sort(),
      });
    }
  });

  it("marks carry no attributes", () => {
    for (const type of Object.values(editorSchema.marks)) {
      expect(Object.keys(type.spec.attrs ?? {})).toEqual([]);
    }
  });

  it("heading levels are the toolbar levels", () => {
    const options = (pageEditorExtensions[0] as unknown as { options: { heading: { levels: number[] } } }).options;
    expect(options.heading.levels).toEqual([...PAGE_HEADING_LEVELS]);
  });
});

describe("accepts what the editor serializes", () => {
  it("AC-29 document (H1–H3, bold, italic, both list types) round-trips unchanged", () => {
    const input = formattedDoc();
    expect(parsePageContent(input)).toEqual(input);
  });

  it("every StarterKit element the editor can produce", () => {
    const input = everyElementDoc();
    expect(parsePageContent(input)).toEqual(input);
  });

  it("an empty document", () => {
    expect(parsePageContent({ type: "doc", content: [] })).toEqual({ type: "doc", content: [] });
    expect(parsePageContent({ type: "doc", content: [{ type: "paragraph" }] })).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("AC-30: <script> / onerror= typed as text is kept verbatim as text", () => {
    const input = xssDoc();
    const parsed = parsePageContent(input);
    expect(parsed).toEqual(input);
    const texts = JSON.stringify(parsed);
    for (const payload of XSS_PAYLOADS) {
      expect(texts).toContain(JSON.stringify(payload).slice(1, -1));
    }
  });

  it("content just under the size limit", () => {
    const big = doc(para(text("x".repeat(PAGE_CONTENT_MAX_BYTES - 200))));
    expect(parsePageContent(big)).toEqual(big);
  });
});

describe("rejects anything else", () => {
  it.each([
    ["an HTML string", "<p>hello</p>"],
    ["a JSON string", JSON.stringify({ type: "doc", content: [] })],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an array", [{ type: "doc", content: [] }]],
    ["a Map", new Map([["type", "doc"]])],
    ["a Date", new Date()],
  ])("%s as the document → not a document", (_label, input) => {
    expectRejected(input, CONTENT_NOT_A_DOCUMENT_MESSAGE);
  });

  it.each([
    ["wrong root type", { type: "paragraph", content: [] }],
    ["missing root type", { content: [] }],
  ])("%s → not a document", (_label, input) => {
    expectRejected(input, CONTENT_NOT_A_DOCUMENT_MESSAGE);
  });

  it.each([
    ["missing content", { type: "doc" }],
    ["content is a string", { type: "doc", content: "<p>x</p>" }],
    ["extra key on the doc", { type: "doc", content: [], html: "<p>x</p>" }],
    ["attrs on the doc", { type: "doc", attrs: { onload: "alert(1)" }, content: [] }],
  ])("%s → unsupported", (_label, input) => {
    expectRejected(input, CONTENT_INVALID_MESSAGE);
  });

  it.each([
    ["an unknown node type", { type: "html", content: [text("<b>x</b>")] }],
    ["a script node", { type: "script", text: "alert(1)" }],
    ["an image with onerror", { type: "image", attrs: { src: "x", onerror: "alert(1)" } }],
    ["an iframe", { type: "iframe", attrs: { src: "https://example.test" } }],
    ["a raw HTML string in place of a node", "<img src=x onerror=alert(1)>"],
    ["a raw HTML string inside a paragraph", para("<b>bold</b>")],
    ["an inline node at block level", text("loose text")],
    ["a block node inside a paragraph", para({ type: "paragraph" })],
    ["an unknown key on a node", { type: "paragraph", html: "<b>x</b>" }],
    ["an event-handler attribute", { type: "paragraph", attrs: { onclick: "alert(1)" } }],
    ["a style attribute on a heading", { type: "heading", attrs: { level: 1, style: "x" }, content: [text("h")] }],
    ["heading level 4", { type: "heading", attrs: { level: 4 }, content: [text("h4")] }],
    ["heading level as string", { type: "heading", attrs: { level: "1" }, content: [text("h")] }],
    ["a link mark with a javascript: href", para(text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))],
    ["an unknown mark", para(text("styled", [{ type: "textStyle", attrs: { color: "red" } }]))],
    ["attributes on a mark", para(text("b", [{ type: "bold", attrs: { style: "x" } }]))],
    ["duplicate marks", para(text("b", [{ type: "bold" }, { type: "bold" }]))],
    ["an empty text node", para(text(""))],
    ["a non-string text", para({ type: "text", text: 42 })],
    ["an unknown key on a text node", para({ type: "text", text: "x", html: "<i>x</i>" })],
    ["marks inside a code block", { type: "codeBlock", content: [text("x", [{ type: "bold" }])] }],
    ["markup in a code-block language", { type: "codeBlock", attrs: { language: '"><script>' }, content: [text("x")] }],
    ["an ordered-list type outside 1/a/A/i/I", { type: "orderedList", attrs: { type: "disc" }, content: [{ type: "listItem", content: [para(text("x"))] }] }],
    ["a non-integer list start", { type: "orderedList", attrs: { start: 1.5 }, content: [{ type: "listItem", content: [para(text("x"))] }] }],
    ["an empty list", { type: "bulletList", content: [] }],
    ["a paragraph directly inside a list", { type: "bulletList", content: [para(text("x"))] }],
    ["an empty list item", { type: "bulletList", content: [{ type: "listItem", content: [] }] }],
    ["an empty blockquote", { type: "blockquote", content: [] }],
    ["content on a horizontal rule", { type: "horizontalRule", content: [para(text("x"))] }],
  ])("%s", (_label, node) => {
    expectRejected(doc(node), CONTENT_INVALID_MESSAGE);
  });

  it("content over 200 KB (UTF-8 bytes, not characters)", () => {
    // 70,000 × "€" is 70,000 characters but 210,000 bytes.
    expectRejected(doc(para(text("€".repeat(70_000)))), CONTENT_TOO_LARGE_MESSAGE);
    expectRejected(doc(para(text("x".repeat(PAGE_CONTENT_MAX_BYTES)))), CONTENT_TOO_LARGE_MESSAGE);
  });

  it("nesting beyond the limit, without a stack overflow", () => {
    let nested: unknown = para(text("deep"));
    for (let i = 0; i < 60; i += 1) nested = { type: "blockquote", content: [nested] };
    expectRejected(doc(nested), CONTENT_TOO_DEEP_MESSAGE);

    // 100,000 levels would overflow a recursive validator or JSON.stringify.
    let hostile: unknown = [];
    for (let i = 0; i < 100_000; i += 1) hostile = [hostile];
    expectRejected({ type: "doc", content: hostile }, CONTENT_TOO_DEEP_MESSAGE);
  });

  it("a cyclic structure", () => {
    const cyclic: Record<string, unknown> = { type: "paragraph" };
    cyclic.content = [cyclic];
    expectRejected(doc(cyclic), CONTENT_TOO_DEEP_MESSAGE);
  });
});
