import StarterKit from "@tiptap/starter-kit";
import { PAGE_HEADING_LEVELS } from "@/lib/page-content-rules";

/**
 * Tiptap extensions of the page editor (P7 = Tiptap StarterKit, PR2).
 *
 * - `link: false`: stored content never carries hrefs (no `javascript:` URLs).
 * - Headings limited to the toolbar levels (H1–H3).
 *
 * The server accepts exactly the node types, marks and attributes of the
 * schema built from this list (`src/server/data/page-content.ts`, checked by
 * `tests/unit/page-content.test.ts`). Change both together.
 */
export const pageEditorExtensions = [
  StarterKit.configure({
    heading: { levels: [...PAGE_HEADING_LEVELS] },
    link: false,
  }),
];
