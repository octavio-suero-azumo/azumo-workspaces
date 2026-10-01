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
    <p role="alert" className="text-xs text-danger">
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
      <label className="ui-label min-w-48 flex-1">
        Email
        <input name="email" type="email" required placeholder="colleague@company" className="ui-input" autoComplete="off" />
      </label>
      <label className="ui-label">
        Role
        <select name="role" defaultValue="viewer" className="ui-select">
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className="ui-button-primary">
        {pending ? "Adding…" : "Add member"}
      </button>
      <div className="basis-full">
        <ErrorText state={state} />
        {state?.ok ? (
          <p role="status" className="text-xs text-success">
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
    <form action={formAction} className="flex flex-wrap items-center gap-2" aria-label={`Change role of ${label}`}>
      <input type="hidden" name="membershipId" value={membershipId} />
      <select name="role" defaultValue={role} aria-label={`Role of ${label}`} className="ui-select w-auto">
        {ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="ui-button-secondary">
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
      <button type="submit" disabled={pending} className="ui-button-danger">
        {pending ? "Removing…" : "Remove"}
      </button>
      <ErrorText state={state} />
    </form>
  );
}
