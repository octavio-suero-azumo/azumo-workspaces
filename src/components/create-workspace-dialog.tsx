"use client";

import { useActionState } from "react";
import { createWorkspaceAction } from "@/app/(app)/workspace-actions";
import { Dialog } from "@/components/ui/dialog";

type CreateWorkspaceState = Awaited<ReturnType<typeof createWorkspaceAction>> | null;

/** "New workspace" dialog (P5: any signed-in user; the creator becomes Owner). */
export function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<CreateWorkspaceState, FormData>(createWorkspaceAction, null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New workspace"
      description="You become its Owner. You can add members afterwards."
      size="sm"
      testId="create-workspace-dialog"
    >
      <form action={formAction} className="flex flex-col gap-3" aria-label="Create workspace">
        <label className="ui-label" htmlFor="new-workspace-name">
          Workspace name
          <input id="new-workspace-name" name="name" required maxLength={100} className="ui-input" autoComplete="off" />
        </label>
        {state && !state.ok ? (
          <p role="alert" className="text-sm text-danger">
            {state.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="ui-button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ui-button-primary" disabled={pending}>
            {pending ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
