"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addMemberAction } from "@/app/(app)/w/[workspaceId]/members/actions";
import { LinkIcon } from "@/components/nav-icons";
import { Dialog } from "@/components/ui/dialog";

/*
 * Share (E7) reuses the workspace membership model — there are no per-page
 * permissions. The dialog states that plainly, lists who has access (every
 * member, with their role), offers Copy link (which grants nothing), and lets
 * an Owner add an EXISTING user to the WHOLE workspace after an explicit
 * confirmation of that scope. Same server rules as the members page: Owner
 * only, P6 (user must have signed in once), allowed domain, last-Owner rule.
 */

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export interface ShareMember {
  membershipId: string;
  name: string;
  email: string;
  role: string;
}

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
  members: ShareMember[];
  canManageMembers: boolean;
  currentUserEmail: string;
  onCopyLink: () => void;
}

export function ShareDialog({
  open,
  onClose,
  workspaceId,
  workspaceName,
  members,
  canManageMembers,
  currentUserEmail,
  onCopyLink,
}: ShareDialogProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setConfirming(false);
    setMessage(null);
  }

  function add() {
    const form = new FormData();
    form.set("workspaceId", workspaceId);
    form.set("email", email);
    form.set("role", role);
    startTransition(async () => {
      const result = await addMemberAction(null, form);
      if (result.ok) {
        setMessage({ kind: "ok", text: `${result.data.email} now has ${ROLE_LABEL[result.data.role]} access to ${workspaceName}.` });
        setEmail("");
        setConfirming(false);
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error.message });
        setConfirming(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Share"
      size="md"
      testId="share-dialog"
      description={
        <>
          This page belongs to <strong className="text-fg">{workspaceName}</strong>. Everyone who is a member of this workspace
          can open it with their workspace role. Copying the link does not give anyone access.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <button type="button" className="ui-button-secondary self-start" onClick={onCopyLink} data-testid="share-copy-link">
          <LinkIcon />
          Copy link
        </button>

        <section aria-labelledby="share-access" className="flex flex-col gap-2">
          <h3 id="share-access" className="ui-section-title">
            People with access ({members.length})
          </h3>
          <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto" data-testid="share-members">
            {members.map((member) => (
              <li key={member.membershipId} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-active text-xs font-semibold"
                >
                  {(member.name || member.email).charAt(0).toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    {member.name}
                    {member.email === currentUserEmail ? " (you)" : ""}
                  </span>
                  <span className="truncate text-xs text-muted">{member.email}</span>
                </span>
                <span className="ui-badge">{ROLE_LABEL[member.role] ?? member.role}</span>
              </li>
            ))}
          </ul>
        </section>

        {canManageMembers ? (
          <section aria-labelledby="share-add" className="flex flex-col gap-2 border-t border-border pt-3">
            <h3 id="share-add" className="ui-section-title">
              Add someone to the workspace
            </h3>
            {!confirming ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setMessage(null);
                  setConfirming(true);
                }}
                aria-label="Add a member to the workspace"
              >
                <label className="ui-label min-w-48 flex-1">
                  Email of someone who has already signed in
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="ui-input"
                    autoComplete="off"
                  />
                </label>
                <label className="ui-label">
                  Workspace role
                  <select value={role} onChange={(event) => setRole(event.target.value)} className="ui-select">
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="owner">Owner</option>
                  </select>
                </label>
                <button type="submit" className="ui-button-secondary">
                  Continue
                </button>
              </form>
            ) : (
              <div role="alertdialog" aria-labelledby="share-confirm-text" className="flex flex-col gap-3 rounded-md bg-hover p-3" data-testid="share-confirm">
                <p id="share-confirm-text" className="text-sm">
                  <strong>{email}</strong> will get <strong>{ROLE_LABEL[role]}</strong> access to the <strong>entire workspace</strong>{" "}
                  “{workspaceName}” — all of its pages, files and calendar, not only this page.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="ui-button-primary" onClick={add} disabled={pending} data-testid="share-confirm-add">
                    {pending ? "Adding…" : "Confirm and add"}
                  </button>
                  <button type="button" className="ui-button-secondary" onClick={() => setConfirming(false)} disabled={pending}>
                    Back
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <p className="border-t border-border pt-3 text-sm text-muted">
            Only workspace Owners can add or remove people.{" "}
            <Link href={`/w/${workspaceId}/members`} className="text-link hover:underline">
              See members
            </Link>
          </p>
        )}

        {message ? (
          <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-danger" : "text-success"}`}>
            {message.text}
          </p>
        ) : null}

        {canManageMembers ? (
          <Link href={`/w/${workspaceId}/members`} className="text-sm text-link hover:underline">
            Manage members and roles
          </Link>
        ) : null}
      </div>
    </Dialog>
  );
}
