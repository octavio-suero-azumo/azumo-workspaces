import Link from "next/link";
import { can } from "@/server/authz/permissions";
import { listMembers } from "@/server/data/members";
import { getWorkspace } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { AddMemberForm, ChangeRoleForm, RemoveMemberForm } from "./member-forms";

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/**
 * Members of a workspace (T-09). Every member can see the list. Controls are
 * rendered only when `can()` allows them for the viewer's role in THIS
 * workspace (R3.4, AC-18); the server enforces every action (R3.2).
 */
export default async function MembersPage({ params }: PageProps<"/w/[workspaceId]/members">) {
  const { workspaceId } = await params;
  const { session, ctx } = await requirePageContext();
  const workspace = await orNotFound(getWorkspace(ctx, workspaceId));
  const members = await orNotFound(listMembers(ctx, workspaceId));

  const canAdd = can(workspace.role, "member.add");
  const canChangeRole = can(workspace.role, "member.changeRole");
  const canRemove = can(workspace.role, "member.remove");

  return (
    <section className="flex flex-col gap-6 p-8">
      <header>
        <Link href={`/w/${workspace.id}`} className="text-sm text-neutral-500 underline underline-offset-2">
          {workspace.name}
        </Link>
        <h1 className="text-2xl font-semibold">Members</h1>
      </header>

      {canAdd ? <AddMemberForm workspaceId={workspace.id} /> : null}

      <table className="w-full max-w-3xl text-left text-sm" data-testid="member-table">
        <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Email</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            {canRemove ? <th className="py-2 font-medium">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const label = member.userId === session.userId ? `${member.name} (you)` : member.name;
            return (
              <tr key={member.membershipId} className="border-b border-neutral-100" data-testid="member-row">
                <td className="py-2 pr-4">{label}</td>
                <td className="py-2 pr-4" data-testid="member-email">
                  {member.email}
                </td>
                <td className="py-2 pr-4" data-testid="member-role">
                  {canChangeRole ? (
                    <ChangeRoleForm membershipId={member.membershipId} role={member.role} label={member.email} />
                  ) : (
                    (ROLE_LABEL[member.role] ?? member.role)
                  )}
                </td>
                {canRemove ? (
                  <td className="py-2">
                    <RemoveMemberForm membershipId={member.membershipId} label={member.email} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
