/**
 * "Copy page contents" (scope expansion 2026-10-01): a readable plain-text
 * rendering of a page — the title plus the editor document, with light
 * Markdown-style markers for structure. Pure and client-safe.
 *
 * Only the page's own title and text are included: no ids, no metadata, no
 * attachment links.
 */

interface DocNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
}

function inlineText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlineText).join("");
}

function blockText(node: DocNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  switch (node.type) {
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      return [`${"#".repeat(level)} ${inlineText(node)}`];
    }
    case "paragraph":
      return [indent + inlineText(node)];
    case "blockquote":
      return (node.content ?? []).flatMap((child) => blockText(child, depth)).map((line) => `> ${line}`);
    case "codeBlock":
      return ["```", inlineText(node), "```"];
    case "horizontalRule":
      return ["---"];
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const start = Number(node.attrs?.start) || 1;
      return (node.content ?? []).flatMap((item, index) => {
        const marker = ordered ? `${start + index}. ` : "- ";
        const [first = "", ...rest] = (item.content ?? []).flatMap((child) => blockText(child, depth + 1));
        return [`${indent}${marker}${first.trimStart()}`, ...rest];
      });
    }
    default:
      return node.content ? node.content.flatMap((child) => blockText(child, depth)) : [];
  }
}

/** Title + document as plain text. `doc` may be null for an empty page. */
export function pageToPlainText(title: string, doc: unknown): string {
  const root = (doc && typeof doc === "object" ? doc : null) as DocNode | null;
  const blocks = (root?.content ?? []).map((node) => blockText(node, 0).join("\n"));
  const body = blocks.filter((block, index) => block.trim().length > 0 || index === 0).join("\n\n").trim();
  return body ? `${title}\n\n${body}\n` : `${title}\n`;
}
