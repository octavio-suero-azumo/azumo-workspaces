"use client";

import { useActionState } from "react";
import { createWorkspaceAction } from "./workspace-actions";

type State = Awaited<ReturnType<typeof createWorkspaceAction>> | null;

export function CreateWorkspaceForm() {
  const [state, formAction, pending] = useActionState<State, FormData>(createWorkspaceAction, null);

  return (
    <form action={formAction} className="flex flex-col gap-2" aria-label="Create workspace">
      <label htmlFor="new-workspace-name" className="text-xs font-medium text-neutral-600">
        New workspace
      </label>
      <input
        id="new-workspace-name"
        name="name"
        required
        maxLength={100}
        placeholder="Workspace name"
        className="rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-2 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
      {state && !state.ok ? (
        <p role="alert" className="text-xs text-red-700">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
