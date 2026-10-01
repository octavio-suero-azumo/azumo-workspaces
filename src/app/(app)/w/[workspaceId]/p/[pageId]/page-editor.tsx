"use client";

import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import { useActionState, useRef, useState } from "react";
import { pageEditorExtensions } from "@/lib/editor/extensions";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { deletePageAction, savePageAction } from "../actions";

/*
 * Page editor (T-11, PR2, P7 = Tiptap StarterKit). Client-only: the editor is
 * created after hydration (`immediatelyRender: false`), so nothing depends on
 * browser APIs during server rendering.
 *
 * Content is rendered ONLY through the editor's schema (ProseMirror builds
 * DOM nodes and text nodes); user content is never injected as raw HTML
 * (AC-30, checked by tests/unit/no-raw-html.test.ts).
 *
 * Controls (title input, toolbar, Save, Delete) are rendered only when the
 * role allows them (R3.4, AC-18). Viewers get a read-only editor
 * (`editable: false`) and no controls. The server enforces every action.
 */

export interface PageEditorProps {
  pageId: string;
  workspaceId: string;
  initialTitle: string;
  initialContent: JSONContent | null;
  canEdit: boolean;
  canDelete: boolean;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** A missing or empty document opens as the editor's default empty paragraph. */
function editorContent(content: JSONContent | null): JSONContent | undefined {
  if (!content || !Array.isArray(content.content) || content.content.length === 0) return undefined;
  return content;
}

export function PageEditor({ pageId, workspaceId, initialTitle, initialContent, canEdit, canDelete }: PageEditorProps) {
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  // Incremented on every local change, so a save that finishes after further
  // edits does not report "Saved".
  const revision = useRef(0);

  const markDirty = () => {
    revision.current += 1;
    setStatus({ kind: "dirty" });
  };

  const editor = useEditor({
    extensions: pageEditorExtensions,
    content: editorContent(initialContent),
    editable: canEdit,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Page content",
        "aria-readonly": canEdit ? "false" : "true",
        class: "page-content min-h-48 rounded border border-neutral-200 px-4 py-3 focus:outline-none",
      },
    },
    onUpdate: () => {
      if (canEdit) markDirty();
    },
  });

  async function save() {
    if (!editor) return;
    const savedRevision = revision.current;
    setStatus({ kind: "saving" });
    try {
      // ProseMirror builds node `attrs` with a null prototype. React cannot
      // send those to a server action (they would arrive as opaque temporary
      // references and fail validation), so send a plain JSON copy.
      const content = JSON.parse(JSON.stringify(editor.getJSON())) as JSONContent;
      const result = await savePageAction({ pageId, workspaceId, title, content });
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error.message });
        return;
      }
      if (revision.current === savedRevision) {
        setTitle(result.data.title);
        setStatus({ kind: "saved" });
      } else {
        setStatus({ kind: "dirty" });
      }
    } catch {
      setStatus({ kind: "error", message: "Could not save. Check your connection and try again." });
    }
  }

  return (
    <article className="flex max-w-3xl flex-col gap-4" data-testid="page-editor">
      {canEdit ? (
        <input
          aria-label="Page title"
          data-testid="page-title-input"
          value={title}
          maxLength={PAGE_TITLE_MAX}
          required
          onChange={(event) => {
            setTitle(event.target.value);
            markDirty();
          }}
          className="rounded border border-neutral-300 px-2 py-1 text-2xl font-semibold"
        />
      ) : (
        <h1 className="text-2xl font-semibold" data-testid="page-title">
          {title}
        </h1>
      )}

      {canEdit && editor ? <Toolbar editor={editor} /> : null}

      {editor ? null : <p className="text-sm text-neutral-500">Loading editor…</p>}
      <EditorContent editor={editor} />

      {canEdit || canDelete ? (
        <div className="flex flex-wrap items-center gap-3">
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={!editor || status.kind === "saving"}
                className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
              >
                {status.kind === "saving" ? "Saving…" : "Save"}
              </button>
              <SaveStatusText status={status} />
            </>
          ) : null}
          {canDelete ? <DeletePage pageId={pageId} workspaceId={workspaceId} /> : null}
        </div>
      ) : null}
    </article>
  );
}

function SaveStatusText({ status }: { status: SaveStatus }) {
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-sm text-red-700" data-testid="save-error">
        {status.message}
      </p>
    );
  }
  const text = status.kind === "saved" ? "Saved" : status.kind === "dirty" ? "Unsaved changes" : "";
  return (
    <p role="status" className="text-sm text-neutral-600" data-testid="save-status">
      {text}
    </p>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      h1: current.isActive("heading", { level: 1 }),
      h2: current.isActive("heading", { level: 2 }),
      h3: current.isActive("heading", { level: 3 }),
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
    }),
  });

  const buttons = [
    { label: "Heading 1", text: "H1", on: active.h1, run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", text: "H2", on: active.h2, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Heading 3", text: "H3", on: active.h3, run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Bold", text: "B", on: active.bold, run: () => editor.chain().focus().toggleBold().run() },
    { label: "Italic", text: "I", on: active.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { label: "Bullet list", text: "• List", on: active.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", text: "1. List", on: active.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
  ];

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1">
      {buttons.map((button) => (
        <button
          key={button.label}
          type="button"
          aria-label={button.label}
          aria-pressed={button.on}
          // Keep the editor's focus and selection while clicking.
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.run}
          className={`rounded border px-2 py-0.5 text-sm ${
            button.on ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 hover:bg-neutral-100"
          }`}
        >
          {button.text}
        </button>
      ))}
    </div>
  );
}

type DeleteState = Awaited<ReturnType<typeof deletePageAction>> | null;

/** Delete with an explicit confirm step (T-12). On success the action redirects. */
function DeletePage({ pageId, workspaceId }: { pageId: string; workspaceId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<DeleteState, FormData>(deletePageAction, null);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
      >
        Delete page
      </button>
    );
  }

  return (
    <form
      action={formAction}
      aria-label="Confirm page deletion"
      data-testid="delete-page-confirm"
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="pageId" value={pageId} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <span className="text-sm text-red-700">Delete this page permanently?</span>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Confirm delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-60"
      >
        Cancel
      </button>
      {state && !state.ok ? (
        <p role="alert" className="basis-full text-xs text-red-700">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
