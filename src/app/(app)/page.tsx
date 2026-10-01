import { redirect } from "next/navigation";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { requirePageContext } from "@/server/render-guards";

/**
 * `/`: open the first of my workspaces, or show the empty state (R2.1).
 * The session is checked here as well as in the layout (they render in
 * parallel, so neither can rely on the other).
 */
export default async function Home() {
  const { ctx } = await requirePageContext();
  const workspaces = await listMyWorkspaces(ctx);
  if (workspaces.length > 0) {
    redirect(`/w/${workspaces[0].id}`);
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" data-testid="empty-state">
      <h1 className="text-xl font-semibold">No workspaces yet</h1>
      <p className="max-w-sm text-sm text-neutral-600">
        You are not a member of any workspace. Create one from the sidebar, or ask a workspace Owner to add you.
      </p>
    </section>
  );
}
