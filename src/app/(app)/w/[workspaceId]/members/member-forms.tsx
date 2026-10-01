"use client";

import { useActionState } from "react";
import { addMemberAction, changeMemberRoleAction, removeMemberAction } from "./actions";

/*
 * Client forms for member management. They are rendered ONLY for roles that
 * may use them (R3.4); the server enforces every action regardless (R3.2).
 */

const ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
] as const;

function ErrorText({ state }: { state: { ok: boolean; error?: { message: string } } | null }) {
  if (!state || state.ok || !state.error) return null;
  return (
    <p role="alert" className="text-xs text-red-700">
      {state.error.message}
    </p>
  );
}

type AddState = Awaited<ReturnType<typeof addMemberAction>> | null;

export function AddMemberForm({ workspaceId }: { workspaceId: string }) {
  const [state, formAction, pending] = useActionState<AddState, FormData>(addMemberAction, null);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" aria-label="Add member" data-testid="add-member-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
        Email
        <input
          name="email"
          type="email"
          required
          placeholder="colleague@company"
          className="rounded border border-neutral-300 px-2 py-1 text-sm font-normal"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
        Role
        <select name="role" defaultValue="viewer" className="rounded border border-neutral-300 px-2 py-1 text-sm font-normal">
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add member"}
      </button>
      <div className="basis-full">
        <ErrorText state={state} />
        {state?.ok ? (
          <p role="status" className="text-xs text-green-700">
            Added {state.data.email}.
          </p>
        ) : null}
      </div>
    </form>
  );
}

type ChangeState = Awaited<ReturnType<typeof changeMemberRoleAction>> | null;

export function ChangeRoleForm({ membershipId, role, label }: { membershipId: string; role: string; label: string }) {
  const [state, formAction, pending] = useActionState<ChangeState, FormData>(changeMemberRoleAction, null);
  return (
    <form action={formAction} className="flex items-center gap-2" aria-label={`Change role of ${label}`}>
      <input type="hidden" name="membershipId" value={membershipId} />
      <select
        name="role"
        defaultValue={role}
        aria-label={`Role of ${label}`}
        className="rounded border border-neutral-300 px-2 py-1 text-sm"
      >
        {ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="rounded border border-neutral-300 px-2 py-1 text-xs disabled:opacity-60">
        {pending ? "Saving…" : "Save role"}
      </button>
      <ErrorText state={state} />
    </form>
  );
}

type RemoveState = Awaited<ReturnType<typeof removeMemberAction>> | null;

export function RemoveMemberForm({ membershipId, label }: { membershipId: string; label: string }) {
  const [state, formAction, pending] = useActionState<RemoveState, FormData>(removeMemberAction, null);
  return (
    <form action={formAction} className="flex items-center gap-2" aria-label={`Remove ${label}`}>
      <input type="hidden" name="membershipId" value={membershipId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      <ErrorText state={state} />
    </form>
  );
}
