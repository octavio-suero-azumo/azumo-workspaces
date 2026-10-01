import Link from "next/link";
import { can } from "@/server/authz/permissions";
import { listAttachments } from "@/server/data/attachments";
import { getPage } from "@/server/data/pages";
import { getWorkspace } from "@/server/data/workspaces";
import { orNotFound, requirePageContext } from "@/server/render-guards";
import { getUploadSettings } from "@/server/uploads/config";
import { PageAttachments } from "./page-attachments";
import { PageEditor } from "./page-editor";

/**
 * Page view / edit (T-10, T-11, T-12; R4.1, PR1, PR2) with its attachments
 * (T-13, T-15, T-16; R4.2–R4.4).
 *
 * The page is authorized by its own id (`page.view`); the route's
 * `workspaceId` must be the page's real workspace, otherwise 404 (DP2). The
 * editing controls are rendered only when the requester's role in the page's
 * workspace allows them (R3.4, AC-18); Viewers get a read-only editor. The
 * server enforces every action regardless (R3.2).
 *
 * Attachments reach the client as id/name/type/size only: no blob URL or
 * pathname is serialized into the HTML or RSC payload (AC-24). The upload
 * settings carry the P8 limits and whether uploads are configured, never the
 * Blob token.
 */
export default async function PageView({ params }: PageProps<"/w/[workspaceId]/p/[pageId]">) {
  const { workspaceId, pageId } = await params;
  const { ctx } = await requirePageContext();
  const page = await orNotFound(getPage(ctx, { pageId, workspaceId }));
  const workspace = await orNotFound(getWorkspace(ctx, page.workspaceId));
  const attachments = await orNotFound(listAttachments(ctx, { pageId: page.id }));
  const uploadSettings = getUploadSettings();

  return (
    <section className="flex flex-col gap-4 p-8">
      <Link href={`/w/${workspace.id}`} className="text-sm text-neutral-500 underline underline-offset-2">
        {workspace.name}
      </Link>
      <PageEditor
        key={page.id}
        pageId={page.id}
        workspaceId={page.workspaceId}
        initialTitle={page.title}
        initialContent={page.content}
        canEdit={can(page.role, "page.edit")}
        canDelete={can(page.role, "page.delete")}
      />
      <PageAttachments
        pageId={page.id}
        workspaceId={page.workspaceId}
        attachments={attachments.map((item) => ({
          id: item.id,
          displayName: item.displayName,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
        }))}
        canAdd={can(page.role, "attachment.add")}
        canDelete={can(page.role, "attachment.delete")}
        uploads={{
          enabled: uploadSettings.enabled,
          maxBytes: uploadSettings.maxBytes,
          allowedTypes: [...uploadSettings.allowedTypes],
        }}
      />
    </section>
  );
}
