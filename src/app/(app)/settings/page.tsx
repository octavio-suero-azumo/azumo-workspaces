import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { TopBar } from "@/components/top-bar";
import { DEFAULT_WORKSPACE_ICON, displayIcon } from "@/lib/icons";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { can } from "@/server/authz/permissions";
import { listMyWorkspaces } from "@/server/data/workspaces";
import { requirePageContext } from "@/server/render-guards";
import { SettingsSignOut, ThemeSwitcher, WorkspaceSettingsForm } from "./settings-client";

export const metadata: Metadata = { title: "Settings · Azumo Workspaces" };

const ROLE_LABEL: Readonly<Record<string, string>> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/**
 * Settings (E6) — only what is implemented: theme, workspace name and icon
 * (Owner), access to the existing member management, and the account
 * (read-only) with Sign out.
 */
export default async function SettingsPage() {
  const { session, ctx } = await requirePageContext();
  const workspaces = await listMyWorkspaces(ctx);
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <>
      <TopBar crumbs={[{ label: "Settings" }]} />
      <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 pb-24 pt-8">
        <h1 className="text-3xl font-bold">Settings</h1>

        <section aria-labelledby="settings-appearance" className="flex flex-col gap-3">
          <h2 id="settings-appearance" className="text-lg font-semibold">
            Appearance
          </h2>
          <ThemeSwitcher initial={theme} />
        </section>

        <section aria-labelledby="settings-workspaces" className="flex flex-col gap-4">
          <h2 id="settings-workspaces" className="text-lg font-semibold">
            Workspaces
          </h2>
          {workspaces.length === 0 ? (
            <p className="text-sm text-muted">You are not a member of any workspace.</p>
          ) : (
            <ul className="flex flex-col gap-4" data-testid="settings-workspaces">
              {workspaces.map((w) => (
                <li key={w.id} className="ui-card flex flex-col gap-3 p-4" data-testid="settings-workspace">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true">{displayIcon(w.icon, DEFAULT_WORKSPACE_ICON)}</span>
                      <span className="truncate font-medium" title={w.name}>
                        {w.name}
                      </span>
                      <span className="ui-badge">{ROLE_LABEL[w.role] ?? w.role}</span>
                    </span>
                    <Link href={`/w/${w.id}/members`} className="ui-button-ghost shrink-0">
                      {can(w.role, "member.add") ? "Manage members" : "View members"}
                    </Link>
                  </div>
                  {can(w.role, "workspace.edit") ? (
                    <WorkspaceSettingsForm workspace={{ id: w.id, name: w.name, icon: w.icon }} />
                  ) : (
                    <p className="text-xs text-muted">Only Owners can change the name and icon of this workspace.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="settings-account" className="flex flex-col gap-3">
          <h2 id="settings-account" className="text-lg font-semibold">
            Account
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd className="min-w-0 truncate">{session.user.name}</dd>
            <dt className="text-muted">Email</dt>
            <dd className="min-w-0 truncate" data-testid="settings-email">
              {session.user.email}
            </dd>
            <dt className="text-muted">Sign-in</dt>
            <dd>Google (corporate account)</dd>
          </dl>
          <div>
            <SettingsSignOut />
          </div>
        </section>
      </main>
    </>
  );
}
