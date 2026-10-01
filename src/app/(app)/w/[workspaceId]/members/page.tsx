import type { Metadata } from "next";
import { TopBar } from "@/components/top-bar";
import { DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { can } from "@/server/authz/permissions";
import { listMembers } from "@/server/data/members";
import { getWorkspace } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { AddMemberForm, ChangeRoleForm, RemoveMemberForm } from "./member-forms";

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export const metadata: Metadata = { title: "Members · Azumo Workspaces" };

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
    <>
      <TopBar
        crumbs={[
          { label: workspace.name, href: `/w/${workspace.id}`, icon: displayIcon(workspace.icon, DEFAULT_WORKSPACE_ICON) },
          { label: "Members" },
        ]}
      />
      <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-24 pt-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Members</h1>
          <p className="text-sm text-muted">
            Members can open every page, file and calendar event of this workspace with their role. Only Owners add, change or
            remove people.
          </p>
        </header>

        {canAdd ? (
          <section aria-labelledby="add-member-heading" className="ui-card flex flex-col gap-2">
            <h2 id="add-member-heading" className="ui-section-title">
              Add someone who has already signed in
            </h2>
            <AddMemberForm workspaceId={workspace.id} />
          </section>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm" data-testid="member-table">
            <caption className="sr-only">Members of {workspace.name}</caption>
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Email
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Role
                </th>
                {canRemove ? (
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const label = member.userId === session.userId ? `${member.name} (you)` : member.name;
                return (
                  <tr key={member.membershipId} className="border-b border-border" data-testid="member-row">
                    <td className="max-w-48 truncate py-2 pr-4" title={label}>
                      {label}
                    </td>
                    <td className="max-w-64 truncate py-2 pr-4" data-testid="member-email" title={member.email}>
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
        </div>
      </main>
    </>
  );
}
