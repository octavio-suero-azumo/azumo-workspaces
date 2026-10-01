"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateWorkspaceAction } from "@/app/(app)/workspace-actions";
import { IconButtonPicker } from "@/components/icon-button-picker";
import { SignOutIcon } from "@/components/nav-icons";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_WORKSPACE_ICON } from "@/lib/icons";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, THEME_LABEL, THEMES, type ThemePreference } from "@/lib/theme";

/*
 * Settings client parts (E6).
 * - Theme: a per-device cookie (visual preference only) + the <html>
 *   attribute updated immediately; the server renders it on the next request.
 * - Workspace name and icon: Owner only; validated again on the server.
 */

/** Persist the theme on this device and apply it to the current document. */
function applyTheme(next: ThemePreference) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  document.documentElement.dataset.theme = next;
}

export function ThemeSwitcher({ initial }: { initial: ThemePreference }) {
  const [theme, setTheme] = useState<ThemePreference>(initial);

  function choose(next: ThemePreference) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <fieldset className="flex flex-col gap-2" data-testid="theme-switcher">
      <legend className="sr-only">Theme</legend>
      <div className="inline-flex w-fit rounded-md border border-border-strong p-0.5">
        {THEMES.map((value) => (
          <label
            key={value}
            className={`cursor-pointer rounded px-3 py-1 text-sm ${theme === value ? "bg-active font-medium text-fg" : "text-muted hover:text-fg"}`}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => choose(value)}
              className="sr-only"
            />
            {THEME_LABEL[value]}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">
        {theme === "system" ? "Follows your device's light or dark setting." : `Always ${THEME_LABEL[theme].toLowerCase()}.`} Saved on this
        device.
      </p>
    </fieldset>
  );
}

export function WorkspaceSettingsForm({ workspace }: { workspace: { id: string; name: string; icon: string | null } }) {
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function rename(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await updateWorkspaceAction({ workspaceId: workspace.id, name });
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error.message });
        return;
      }
      setName(result.data.name);
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <IconButtonPicker
        icon={workspace.icon}
        defaultIcon={DEFAULT_WORKSPACE_ICON}
        canEdit
        size="lg"
        label={`Workspace icon of ${workspace.name}`}
        testId={`settings-workspace-icon-${workspace.id}`}
        save={async (next) => {
          const result = await updateWorkspaceAction({ workspaceId: workspace.id, icon: next });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        }}
      />
      <form onSubmit={rename} className="flex min-w-0 flex-1 flex-wrap items-end gap-2" aria-label={`Rename ${workspace.name}`}>
        <label className="ui-label min-w-48 flex-1">
          Workspace name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required className="ui-input" />
        </label>
        <button type="submit" className="ui-button-secondary" disabled={pending || name.trim() === workspace.name}>
          {pending ? "Saving…" : "Rename"}
        </button>
        {message ? (
          <p role={message.kind === "error" ? "alert" : "status"} className={`basis-full text-xs ${message.kind === "error" ? "text-danger" : "text-success"}`}>
            {message.text}
          </p>
        ) : null}
      </form>
    </div>
  );
}

export function SettingsSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="ui-button-secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      <SignOutIcon />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
