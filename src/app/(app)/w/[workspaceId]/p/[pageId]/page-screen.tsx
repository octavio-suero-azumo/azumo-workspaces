"use client";

import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { IconButtonPicker } from "@/components/icon-button-picker";
import {
  CopyIcon,
  DuplicateIcon,
  FileIcon,
  LinkIcon,
  MoreIcon,
  MoveIcon,
  ShareIcon,
  TrashIcon,
} from "@/components/nav-icons";
import { TopBar } from "@/components/top-bar";
import { Dialog } from "@/components/ui/dialog";
import { Menu, type MenuSection } from "@/components/ui/menu";
import { pageEditorExtensions } from "@/lib/editor/extensions";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { PAGE_FONT_LABEL, PAGE_FONTS, type PageFont, type PagePresentation } from "@/lib/page-presentation";
import { pageToPlainText } from "@/lib/page-text";
import {
  duplicatePageAction,
  movePageAction,
  savePageAction,
  trashPageAction,
  updatePageIconAction,
  updatePagePresentationAction,
} from "../actions";
import { PageAttachments, type AttachmentItem, type UploadSettingsProps } from "./page-attachments";
import { ShareDialog, type ShareMember } from "./share-dialog";

/*
 * Page screen (T-11 editor; scope expansion E1, E2, E5, E7–E10).
 *
 * - Content is rendered ONLY through the editor's schema; user content is
 *   never injected as raw HTML (AC-30, tests/unit/no-raw-html.test.ts).
 * - Controls exist only for roles that may use them (R3.4): Viewers get a
 *   read-only document and a menu with Copy link / Copy contents / Share.
 *   The server enforces every action regardless.
 * - "Saved" is shown only after the server confirmed the save (no fake
 *   autosave). Unsaved changes are guarded before leaving, moving,
 *   duplicating or trashing (save / discard / cancel).
 */

export interface PageScreenProps {
  page: {
    id: string;
    title: string;
    icon: string | null;
    content: JSONContent | null;
    presentation: PagePresentation;
  };
  workspace: { id: string; name: string; icon: string | null };
  permissions: {
    canEdit: boolean;
    canTrash: boolean;
    canDuplicate: boolean;
    canMove: boolean;
    canManageMembers: boolean;
    canAddAttachment: boolean;
    canDeleteAttachment: boolean;
  };
  moveTargets: { id: string; name: string; icon: string | null }[];
  members: ShareMember[];
  currentUserEmail: string;
  attachments: AttachmentItem[];
  uploads: UploadSettingsProps;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type PendingAction = "move" | "duplicate" | "trash";

/** A missing or empty document opens as the editor's default empty paragraph. */
function editorContent(content: JSONContent | null): JSONContent | undefined {
  if (!content || !Array.isArray(content.content) || content.content.length === 0) return undefined;
  return content;
}

/** ProseMirror attrs have a null prototype; server actions need plain JSON. */
function plainDoc(editor: Editor): JSONContent {
  return JSON.parse(JSON.stringify(editor.getJSON())) as JSONContent;
}

export function PageScreen(props: PageScreenProps) {
  const { page, workspace, permissions } = props;
  const router = useRouter();
  const [title, setTitle] = useState(page.title);
  const [icon, setIcon] = useState<string | null>(page.icon);
  const [presentation, setPresentation] = useState<PagePresentation>(page.presentation);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [iconOpenSignal, setIconOpenSignal] = useState(0);
  const [guard, setGuard] = useState<PendingAction | null>(null);
  const [copyFallback, setCopyFallback] = useState<{ label: string; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  const revision = useRef(0);
  const dirty = status.kind === "dirty" || status.kind === "error";
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const markDirty = useCallback(() => {
    revision.current += 1;
    setStatus({ kind: "dirty" });
  }, []);

  const editor = useEditor({
    extensions: pageEditorExtensions,
    content: editorContent(page.content),
    editable: permissions.canEdit,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Page content",
        "aria-readonly": permissions.canEdit ? "false" : "true",
        class: "page-content",
      },
    },
    onUpdate: () => {
      if (permissions.canEdit) markDirty();
    },
  });

  // ---------------------------------------------------------------- save

  const save = useCallback(async (): Promise<boolean> => {
    if (!editor || !permissions.canEdit) return false;
    const savedRevision = revision.current;
    setStatus({ kind: "saving" });
    try {
      const result = await savePageAction({ pageId: page.id, workspaceId: workspace.id, title, content: plainDoc(editor) });
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error.message });
        return false;
      }
      if (revision.current === savedRevision) {
        setTitle(result.data.title);
        setStatus({ kind: "saved" });
      } else {
        setStatus({ kind: "dirty" });
      }
      router.refresh();
      return true;
    } catch {
      setStatus({ kind: "error", message: "Could not save. Check your connection and try again." });
      return false;
    }
  }, [editor, permissions.canEdit, page.id, workspace.id, title, router]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    if (!permissions.canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [permissions.canEdit, save]);

  // ------------------------------------------------ unsaved-changes guards

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    // In-app links: ask before leaving with unsaved changes.
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm("You have unsaved changes on this page. Leave without saving?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  /** Run an action now, or ask first when there are unsaved changes. */
  function guarded(action: PendingAction) {
    if (dirty) {
      setGuard(action);
      return;
    }
    openAction(action);
  }

  function openAction(action: PendingAction) {
    if (action === "move") setMoveOpen(true);
    else if (action === "trash") setTrashOpen(true);
    else duplicate();
  }

  async function resolveGuard(choice: "save" | "discard") {
    const action = guard;
    setGuard(null);
    if (!action) return;
    if (choice === "save") {
      const ok = await save();
      if (!ok) return;
    } else {
      editor?.commands.setContent(editorContent(page.content) ?? "", { emitUpdate: false });
      setTitle(page.title);
      setStatus({ kind: "idle" });
      dirtyRef.current = false;
    }
    openAction(action);
  }

  // ------------------------------------------------------------- actions

  const pageUrl = () => `${window.location.origin}/p/${page.id}`;

  async function copyText(label: string, text: string) {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "ok", text: `${label} copied.` });
    } catch {
      setCopyFallback({ label, text });
    }
  }

  function copyLink() {
    void copyText("Link", pageUrl());
  }

  function copyContents() {
    const doc = editor ? plainDoc(editor) : page.content;
    void copyText("Page contents", pageToPlainText(title, doc));
  }

  function duplicate() {
    setNotice(null);
    startTransition(async () => {
      const result = await duplicatePageAction({ pageId: page.id });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error.message });
        return;
      }
      router.push(`/w/${result.data.workspaceId}/p/${result.data.id}`);
      router.refresh();
    });
  }

  function trash() {
    startTransition(async () => {
      const result = await trashPageAction({ pageId: page.id, workspaceId: workspace.id });
      if (!result.ok) {
        setTrashOpen(false);
        setNotice({ kind: "error", text: result.error.message });
        return;
      }
      dirtyRef.current = false;
      router.push(`/w/${result.data.workspaceId}`);
      router.refresh();
    });
  }

  function setPresentationValue(change: Partial<PagePresentation>) {
    const previous = presentation;
    const next = { ...presentation, ...change };
    setPresentation(next);
    startTransition(async () => {
      const result = await updatePagePresentationAction({ pageId: page.id, ...change });
      if (!result.ok) {
        setPresentation(previous);
        setNotice({ kind: "error", text: result.error.message });
      }
    });
  }

  // ---------------------------------------------------------------- menu

  const sections: MenuSection[] = [];
  if (permissions.canEdit) {
    sections.push({
      key: "style",
      label: "Style",
      items: [
        ...PAGE_FONTS.map((font: PageFont) => ({
          kind: "radio" as const,
          key: `font-${font}`,
          label: `${PAGE_FONT_LABEL[font]} font`,
          checked: presentation.font === font,
          testId: `menu-font-${font}`,
          onSelect: () => setPresentationValue({ font }),
        })),
        {
          kind: "checkbox" as const,
          key: "small-text",
          label: "Small text",
          checked: presentation.smallText,
          testId: "menu-small-text",
          onSelect: () => setPresentationValue({ smallText: !presentation.smallText }),
        },
        {
          kind: "checkbox" as const,
          key: "full-width",
          label: "Full width",
          checked: presentation.fullWidth,
          testId: "menu-full-width",
          onSelect: () => setPresentationValue({ fullWidth: !presentation.fullWidth }),
        },
      ],
    });
  }
  sections.push({
    key: "page",
    label: "Page",
    items: [
      ...(permissions.canEdit
        ? [{ key: "icon", label: "Change icon", icon: <FileIcon />, testId: "menu-change-icon", onSelect: () => setIconOpenSignal((n) => n + 1) }]
        : []),
      { key: "copy-link", label: "Copy link", icon: <LinkIcon />, testId: "menu-copy-link", onSelect: copyLink },
      { key: "copy-contents", label: "Copy page contents", icon: <CopyIcon />, testId: "menu-copy-contents", onSelect: copyContents },
      { key: "share", label: "Share", icon: <ShareIcon />, testId: "menu-share", onSelect: () => setShareOpen(true) },
      ...(permissions.canDuplicate
        ? [{ key: "duplicate", label: "Duplicate", icon: <DuplicateIcon />, testId: "menu-duplicate", onSelect: () => guarded("duplicate") }]
        : []),
      ...(permissions.canMove
        ? [{ key: "move", label: "Move to…", icon: <MoveIcon />, testId: "menu-move", onSelect: () => guarded("move") }]
        : []),
    ],
  });
  if (permissions.canTrash) {
    sections.push({
      key: "danger",
      items: [
        { key: "trash", label: "Move to Trash", icon: <TrashIcon />, danger: true, testId: "menu-trash", onSelect: () => guarded("trash") },
      ],
    });
  }

  const statusText =
    status.kind === "saved"
      ? "Saved"
      : status.kind === "saving"
        ? "Saving…"
        : status.kind === "dirty"
          ? "Unsaved changes"
          : "";

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspace.name, href: `/w/${workspace.id}`, icon: displayIcon(workspace.icon, DEFAULT_WORKSPACE_ICON) },
          { label: title || "Untitled", icon: displayIcon(icon, DEFAULT_PAGE_ICON) },
        ]}
        actions={
          <>
            {permissions.canEdit ? (
              <>
                <span role="status" className="hidden text-xs text-muted sm:inline" data-testid="save-status">
                  {statusText}
                </span>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!editor || status.kind === "saving"}
                  className={dirty ? "ui-button-primary min-h-7 px-3" : "ui-button-ghost"}
                  data-testid="save-button"
                >
                  {status.kind === "saving" ? "Saving…" : "Save"}
                </button>
              </>
            ) : null}
            <button type="button" className="ui-button-ghost" onClick={() => setShareOpen(true)} data-testid="share-button">
              Share
            </button>
            <Menu label="Page actions" trigger={<MoreIcon />} sections={sections} testId="page-menu" />
          </>
        }
      />

      <main id="main-content" className="flex-1 pt-10">
        <article
          className="page-document"
          data-font={presentation.font}
          data-small-text={presentation.smallText ? "true" : "false"}
          data-full-width={presentation.fullWidth ? "true" : "false"}
          data-testid="page-editor"
        >
          <PageIcon
            pageId={page.id}
            icon={icon}
            canEdit={permissions.canEdit}
            openSignal={iconOpenSignal}
            onSaved={setIcon}
            title={title}
          />

          {permissions.canEdit ? (
            <TitleInput
              value={title}
              onChange={(value) => {
                setTitle(value);
                markDirty();
              }}
            />
          ) : (
            <h1 className="page-title-input" data-testid="page-title">
              {title}
            </h1>
          )}

          {status.kind === "error" ? (
            <p role="alert" className="mt-2 text-sm text-danger" data-testid="save-error">
              {status.message}
            </p>
          ) : null}

          {permissions.canEdit && editor ? <Toolbar editor={editor} /> : null}
          {editor ? null : <p className="mt-4 text-sm text-muted">Loading editor…</p>}
          <div className="mt-4">
            <EditorContent editor={editor} />
          </div>

          <PageAttachments
            pageId={page.id}
            workspaceId={workspace.id}
            attachments={props.attachments}
            canAdd={permissions.canAddAttachment}
            canDelete={permissions.canDeleteAttachment}
            uploads={props.uploads}
            onBusyChange={setUploadBusy}
          />
        </article>
      </main>

      {notice ? (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-4 py-2 text-sm shadow-lg ${
            notice.kind === "error" ? "bg-[var(--danger)] text-white" : "bg-[var(--text)] text-[var(--bg)]"
          }`}
          data-testid="page-notice"
        >
          {notice.text}
          <button type="button" className="ml-3 underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        members={props.members}
        canManageMembers={permissions.canManageMembers}
        currentUserEmail={props.currentUserEmail}
        onCopyLink={copyLink}
      />

      <MoveDialog
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        pageId={page.id}
        targets={props.moveTargets}
        uploadBusy={uploadBusy}
        onMoved={(workspaceId) => {
          dirtyRef.current = false;
          router.push(`/w/${workspaceId}/p/${page.id}`);
          router.refresh();
        }}
      />

      <Dialog
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Move to Trash?"
        description="The page, its content and its files are kept. Owners and Editors can restore it from Trash."
        size="sm"
        testId="trash-dialog"
      >
        <div className="flex justify-end gap-2">
          <button type="button" className="ui-button-secondary" onClick={() => setTrashOpen(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="ui-button-danger" onClick={trash} disabled={busy} data-testid="trash-confirm">
            {busy ? "Moving…" : "Move to Trash"}
          </button>
        </div>
      </Dialog>

      <Dialog
        open={guard !== null}
        onClose={() => setGuard(null)}
        title="Unsaved changes"
        description="Save your changes before continuing, or discard them."
        size="sm"
        testId="unsaved-dialog"
      >
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="ui-button-secondary" onClick={() => setGuard(null)}>
            Cancel
          </button>
          <button type="button" className="ui-button-secondary" onClick={() => void resolveGuard("discard")}>
            Discard changes
          </button>
          <button type="button" className="ui-button-primary" onClick={() => void resolveGuard("save")}>
            Save and continue
          </button>
        </div>
      </Dialog>

      <Dialog
        open={copyFallback !== null}
        onClose={() => setCopyFallback(null)}
        title={`Copy ${copyFallback?.label.toLowerCase() ?? ""}`}
        description="The clipboard is not available here. Select the text below and copy it."
        size="md"
        testId="copy-fallback"
      >
        <textarea
          readOnly
          className="ui-textarea min-h-24 font-mono text-xs"
          value={copyFallback?.text ?? ""}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={copyFallback?.label ?? "Text to copy"}
          autoFocus
        />
      </Dialog>
    </>
  );
}

/** Borderless, auto-growing title (Owner/Editor). */
function TitleInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Page title"
      data-testid="page-title-input"
      value={value}
      maxLength={PAGE_TITLE_MAX}
      placeholder="Untitled"
      onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }}
      className="page-title-input"
    />
  );
}

function PageIcon({
  pageId,
  icon,
  canEdit,
  openSignal,
  onSaved,
  title,
}: {
  pageId: string;
  icon: string | null;
  canEdit: boolean;
  openSignal: number;
  onSaved: (icon: string | null) => void;
  title: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  // "Change icon" in the menu opens the same picker as clicking the icon.
  useEffect(() => {
    if (openSignal > 0) wrapper.current?.querySelector<HTMLButtonElement>("button")?.click();
  }, [openSignal]);
  return (
    <div ref={wrapper} className="mb-2">
      <IconButtonPicker
        icon={icon}
        defaultIcon={DEFAULT_PAGE_ICON}
        canEdit={canEdit}
        label={`Page icon of ${title || "Untitled"}`}
        testId="page-icon"
        onSaved={onSaved}
        save={async (next) => {
          const result = await updatePageIconAction({ pageId, icon: next });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        }}
      />
    </div>
  );
}

function MoveDialog({
  open,
  onClose,
  pageId,
  targets,
  uploadBusy,
  onMoved,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  targets: { id: string; name: string; icon: string | null }[];
  uploadBusy: boolean;
  onMoved: (workspaceId: string) => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function move() {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const result = await movePageAction({ pageId, destinationWorkspaceId: selected });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onMoved(result.data.workspaceId);
    });
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(null);
        onClose();
      }}
      title="Move to…"
      size="md"
      testId="move-dialog"
      description="The page and its files will inherit the permissions of the destination workspace. Some people may lose or gain access."
    >
      {uploadBusy ? (
        <p role="alert" className="text-sm text-warning">
          A file is still uploading. Wait for it to finish, then move the page.
        </p>
      ) : targets.length === 0 ? (
        <p className="text-sm text-muted">
          You can only move pages to workspaces where you are an Owner or Editor, and you have no other such workspace.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1" disabled={pending}>
          <legend className="ui-section-title mb-1">Destination workspace</legend>
          {targets.map((target) => (
            <label key={target.id} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
              <input
                type="radio"
                name="move-destination"
                value={target.id}
                checked={selected === target.id}
                onChange={() => setSelected(target.id)}
              />
              <span aria-hidden="true">{displayIcon(target.icon, DEFAULT_WORKSPACE_ICON)}</span>
              <span className="truncate text-sm">{target.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-button-secondary" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className="ui-button-primary"
          onClick={move}
          disabled={pending || uploadBusy || !selected}
          data-testid="move-confirm"
        >
          {pending ? "Moving…" : "Move page"}
        </button>
      </div>
    </Dialog>
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
    { label: "Bold", text: "B", on: active.bold, run: () => editor.chain().focus().toggleBold().run(), className: "font-bold" },
    { label: "Italic", text: "I", on: active.italic, run: () => editor.chain().focus().toggleItalic().run(), className: "italic" },
    { label: "Bullet list", text: "• List", on: active.bulletList, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", text: "1. List", on: active.orderedList, run: () => editor.chain().focus().toggleOrderedList().run() },
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-11 z-20 mt-4 flex flex-wrap gap-0.5 border-b border-border bg-bg py-1"
    >
      {buttons.map((button) => (
        <button
          key={button.label}
          type="button"
          aria-label={button.label}
          aria-pressed={button.on}
          // Keep the editor's focus and selection while clicking.
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.run}
          className={`min-h-7 rounded-md px-2 text-sm ${button.className ?? ""} ${
            button.on ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          {button.text}
        </button>
      ))}
    </div>
  );
}
