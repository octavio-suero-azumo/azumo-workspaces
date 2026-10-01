"use client";

import { upload } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, type FormEvent } from "react";
import {
  buildUploadPathname,
  codePointLength,
  ATTACHMENT_DISPLAY_NAME_MAX,
  fileDownloadPath,
  formatBytes,
  normalizeContentType,
  sanitizeDisplayName,
  UPLOAD_TOKEN_ROUTE,
  UPLOADS_NOT_CONFIGURED_MESSAGE,
  uploadProblem,
} from "@/lib/attachment-rules";
import { deleteAttachmentAction, registerUploadAction } from "../attachment-actions";

/*
 * Page attachments (T-13 list, T-15 upload, T-16 download/delete).
 *
 * - Every member sees the list. Download links point ONLY to the app route
 *   `/api/files/{id}`; no blob URL or pathname is ever rendered (AC-24).
 * - Owner/Editor (R3.4, AC-18) see the upload form and delete buttons;
 *   Viewers see neither. The server enforces every action regardless.
 * - When the server has no Blob token, the upload form stays visible to
 *   Owner/Editor but disabled, with "Uploads are not configured".
 * - Upload: the browser checks size/type (convenience only), uploads straight
 *   to the PRIVATE Blob store with a token from `/api/uploads`, then calls
 *   `registerUpload`, which re-checks everything server-side.
 */

export interface AttachmentItem {
  id: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadSettingsProps {
  enabled: boolean;
  maxBytes: number;
  allowedTypes: readonly string[];
}

export interface PageAttachmentsProps {
  pageId: string;
  workspaceId: string;
  attachments: AttachmentItem[];
  canAdd: boolean;
  canDelete: boolean;
  uploads: UploadSettingsProps;
}

export function PageAttachments({ pageId, workspaceId, attachments, canAdd, canDelete, uploads }: PageAttachmentsProps) {
  return (
    <section aria-labelledby="attachments-heading" className="flex max-w-3xl flex-col gap-3" data-testid="attachments">
      <h2 id="attachments-heading" className="text-sm font-medium uppercase tracking-wide text-neutral-500">
        Attachments
      </h2>
      {attachments.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="attachments-empty">
          No files attached.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200 rounded border border-neutral-200" data-testid="attachment-list">
          {attachments.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm" data-testid="attachment-item">
              <a
                href={fileDownloadPath(item.id)}
                download
                className="font-medium underline underline-offset-2"
                data-testid="attachment-download"
              >
                {item.displayName}
              </a>
              <span className="text-xs text-neutral-500" data-testid="attachment-size">
                {formatBytes(item.sizeBytes)}
              </span>
              {canDelete ? <DeleteAttachment attachmentId={item.id} displayName={item.displayName} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canAdd ? <UploadAttachment pageId={pageId} workspaceId={workspaceId} uploads={uploads} /> : null}
    </section>
  );
}

type DeleteState = Awaited<ReturnType<typeof deleteAttachmentAction>> | null;

function DeleteAttachment({ attachmentId, displayName }: { attachmentId: string; displayName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<DeleteState, FormData>(deleteAttachmentAction, null);

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Delete file ${displayName}`}
        onClick={() => setConfirming(true)}
        className="ml-auto rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
      >
        Delete
      </button>
    );
  }

  return (
    <form
      action={formAction}
      aria-label={`Confirm deletion of ${displayName}`}
      data-testid="delete-attachment-confirm"
      className="ml-auto flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="attachmentId" value={attachmentId} />
      <span className="text-xs text-red-700">Delete this file permanently?</span>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-red-700 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Yes, delete file"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="rounded border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-60"
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

type UploadStatus =
  | { kind: "idle" }
  | { kind: "uploading"; percentage: number }
  | { kind: "registering" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

const UPLOAD_FAILED_MESSAGE =
  "The upload failed or was not allowed. Check the file type and size, and that you can edit this page.";

function UploadAttachment({
  pageId,
  workspaceId,
  uploads,
}: {
  pageId: string;
  workspaceId: string;
  uploads: UploadSettingsProps;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const busy = status.kind === "uploading" || status.kind === "registering";
  const disabled = !uploads.enabled || busy;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploads.enabled) return;
    const form = event.currentTarget;
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setStatus({ kind: "error", message: "Choose a file first." });
      return;
    }
    const contentType = normalizeContentType(file.type);
    const displayName = sanitizeDisplayName(file.name);
    // Convenience checks only; the server enforces the same rules.
    const problem =
      uploadProblem({ size: file.size, contentType }, uploads) ??
      (displayName.length === 0 || codePointLength(displayName) > ATTACHMENT_DISPLAY_NAME_MAX
        ? `File names must be 1–${ATTACHMENT_DISPLAY_NAME_MAX} characters.`
        : null);
    if (problem) {
      setStatus({ kind: "error", message: problem });
      return;
    }

    setStatus({ kind: "uploading", percentage: 0 });
    let pathname: string;
    try {
      const blob = await upload(buildUploadPathname(workspaceId, pageId, file.name), file, {
        access: "private",
        handleUploadUrl: UPLOAD_TOKEN_ROUTE,
        clientPayload: JSON.stringify({ pageId, size: file.size, contentType }),
        contentType,
        onUploadProgress: ({ percentage }) => setStatus({ kind: "uploading", percentage }),
      });
      // Only the pathname is kept; the blob URL is never used or shown.
      pathname = blob.pathname;
    } catch {
      setStatus({ kind: "error", message: UPLOAD_FAILED_MESSAGE });
      return;
    }

    setStatus({ kind: "registering" });
    try {
      const result = await registerUploadAction({ pageId, pathname, displayName });
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error.message });
        return;
      }
      form.reset();
      setStatus({ kind: "done", message: `Attached ${result.data.displayName}.` });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Could not save the attachment. Check your connection and try again." });
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Upload a file"
      data-testid="upload-form"
      className="flex flex-col gap-2 rounded border border-dashed border-neutral-300 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="attachment-file">
          Attach a file
        </label>
        <input
          id="attachment-file"
          ref={inputRef}
          type="file"
          name="file"
          accept={uploads.allowedTypes.join(",")}
          disabled={disabled}
          data-testid="upload-input"
          className="text-sm disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
      {uploads.enabled ? (
        <p className="text-xs text-neutral-500">
          Up to {formatBytes(uploads.maxBytes)}. PDF, images, text, CSV and Office documents.
        </p>
      ) : (
        <p role="status" className="text-sm text-amber-800" data-testid="uploads-not-configured">
          {UPLOADS_NOT_CONFIGURED_MESSAGE}
        </p>
      )}
      <UploadStatusText status={status} />
    </form>
  );
}

function UploadStatusText({ status }: { status: UploadStatus }) {
  switch (status.kind) {
    case "uploading":
      return (
        <div className="flex items-center gap-2 text-xs text-neutral-600" data-testid="upload-progress">
          <progress value={Math.round(status.percentage)} max={100} aria-label="Upload progress" />
          <span>{Math.round(status.percentage)}%</span>
        </div>
      );
    case "registering":
      return (
        <p role="status" className="text-xs text-neutral-600">
          Saving…
        </p>
      );
    case "done":
      return (
        <p role="status" className="text-xs text-green-700" data-testid="upload-done">
          {status.message}
        </p>
      );
    case "error":
      return (
        <p role="alert" className="text-xs text-red-700" data-testid="upload-error">
          {status.message}
        </p>
      );
    default:
      return null;
  }
}
