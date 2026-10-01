import { redirect } from "next/navigation";
import { getPage } from "@/server/data/pages";
import { orNotFound, requirePageContext } from "@/server/render-guards";

/**
 * Stable page link `/p/{pageId}` (E5 "Copy link", DP16, AC-49).
 *
 * The link itself grants nothing: the requester must be signed in (no session
 * → /sign-in) and be a member of the workspace the page is in NOW. Members
 * are redirected to the page's current location (so the link keeps working
 * after a Move); non-members, unknown ids and trashed pages all get the same
 * 404, without revealing whether the page exists.
 */
export default async function PageLink({ params }: PageProps<"/p/[pageId]">) {
  const { pageId } = await params;
  const { ctx } = await requirePageContext();
  const page = await orNotFound(getPage(ctx, { pageId }));
  redirect(`/w/${page.workspaceId}/p/${page.id}`);
}
