import type { Metadata } from "next";
import { LocalDateTime } from "@/components/local-time";
import { TopBar } from "@/components/top-bar";
import { DEFAULT_PAGE_ICON, DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { listTrash } from "@/server/data/pages";
import { requirePageContext } from "@/server/render-guards";
import { RestoreButton } from "./restore-button";

export const metadata: Metadata = { title: "Trash · Azumo Workspaces" };

/**
 * Trash (E10, DP13, DP15): pages moved to Trash in the workspaces where I may
 * manage it (Owner, Editor). Pages keep their content and files; Restore puts
 * them back in their original workspace. There is no permanent delete.
 */
export default async function TrashPage() {
  const { ctx } = await requirePageContext();
  const items = await listTrash(ctx);

  return (
    <>
      <TopBar crumbs={[{ label: "Trash" }]} />
      <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-24 pt-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Trash</h1>
          <p className="text-sm text-muted">
            Pages moved to Trash keep their content and files. Owners and Editors of a workspace can restore its pages. Pages are
            not deleted permanently.
          </p>
        </header>
        {items.length === 0 ? (
          <p className="text-sm text-muted" data-testid="trash-empty">
            Trash is empty.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="trash-list">
            {items.map((item) => (
              <li key={item.id} className="flex min-w-0 items-center gap-3 py-3" data-testid="trash-item">
                <span aria-hidden="true" className="shrink-0 text-lg">
                  {displayIcon(item.icon, DEFAULT_PAGE_ICON)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium" title={item.title}>
                    {item.title}
                  </span>
                  <span className="truncate text-xs text-muted">
                    In {displayIcon(item.workspaceIcon, DEFAULT_WORKSPACE_ICON)} {item.workspaceName} ·{" "}
                    <LocalDateTime iso={item.deletedAt.toISOString()} prefix="Deleted" />
                    {item.deletedByName ? ` by ${item.deletedByName}` : ""}
                  </span>
                </span>
                <RestoreButton pageId={item.id} title={item.title} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
