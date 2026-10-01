import type { Metadata } from "next";
import { can } from "@/server/authz/permissions";
import { listAttachments } from "@/server/data/attachments";
import { listMembers } from "@/server/data/members";
import { getPage } from "@/server/data/pages";
import { getWorkspace, listMyWorkspaces } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { getUploadSettings } from "@/server/uploads/config";
import { PageScreen } from "./page-screen";

/**
 * Page view / edit (T-10, T-11; E1, E2, E5, E7–E10).
 *
 * The page is authorized by its own id (`page.view`); the route's
 * `workspaceId` must be the page's real workspace, otherwise 404 (DP2, DP16).
 * Trashed pages are 404 here (AC-42). Controls are passed as booleans from
 * the requester's role in the page's workspace (R3.4); the server enforces
 * every action regardless (R3.2).
 *
 * Attachments reach the client as id/name/type/size only: no blob URL or
 * pathname is serialized into the HTML or RSC payload (AC-24).
 */
export async function generateMetadata({ params }: PageProps<"/w/[workspaceId]/p/[pageId]">): Promise<Metadata> {
  const { workspaceId, pageId } = await params;
  try {
    const { ctx } = await requirePageContext();
    const page = await getPage(ctx, { pageId, workspaceId });
    return { title: `${page.title} · Azumo Workspaces` };
  } catch {
    return { title: "Azumo Workspaces" };
  }
}

export default async function PageView({ params }: PageProps<"/w/[workspaceId]/p/[pageId]">) {
  const { workspaceId, pageId } = await params;
  const { session, ctx } = await requirePageContext();
  const page = await orNotFound(getPage(ctx, { pageId, workspaceId }));
  const [workspace, attachments, members, myWorkspaces] = await Promise.all([
    orNotFound(getWorkspace(ctx, page.workspaceId)),
    orNotFound(listAttachments(ctx, { pageId: page.id })),
    orNotFound(listMembers(ctx, page.workspaceId)),
    listMyWorkspaces(ctx),
  ]);
  const uploadSettings = getUploadSettings();
  const role = page.role;

  return (
    <PageScreen
      key={page.id}
      page={{
        id: page.id,
        title: page.title,
        icon: page.icon,
        content: page.content,
        presentation: { font: page.font, smallText: page.smallText, fullWidth: page.fullWidth },
      }}
      workspace={{ id: workspace.id, name: workspace.name, icon: workspace.icon }}
      permissions={{
        canEdit: can(role, "page.edit"),
        canTrash: can(role, "page.trash"),
        canDuplicate: can(role, "page.duplicate"),
        canMove: can(role, "page.move"),
        canManageMembers: can(role, "member.add"),
        canAddAttachment: can(role, "attachment.add"),
        canDeleteAttachment: can(role, "attachment.delete"),
      }}
      moveTargets={myWorkspaces
        .filter((w) => w.id !== page.workspaceId && can(w.role, "page.create"))
        .map((w) => ({ id: w.id, name: w.name, icon: w.icon }))}
      members={members.map((m) => ({ membershipId: m.membershipId, name: m.name, email: m.email, role: m.role }))}
      currentUserEmail={session.user.email}
      attachments={attachments.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
      }))}
      uploads={{
        enabled: uploadSettings.enabled,
        maxBytes: uploadSettings.maxBytes,
        allowedTypes: [...uploadSettings.allowedTypes],
      }}
    />
  );
}
