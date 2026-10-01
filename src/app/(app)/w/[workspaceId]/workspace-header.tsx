"use client";

import { updateWorkspaceAction } from "@/app/(app)/workspace-actions";
import { IconButtonPicker } from "@/components/icon-button-picker";
import { DEFAULT_WORKSPACE_ICON } from "@/lib/icons";

/** Workspace icon on its home page: Owners can change it (E2, `workspace.edit`). */
export function WorkspaceIcon({ workspaceId, icon, canEdit, name }: { workspaceId: string; icon: string | null; canEdit: boolean; name: string }) {
  return (
    <IconButtonPicker
      icon={icon}
      defaultIcon={DEFAULT_WORKSPACE_ICON}
      canEdit={canEdit}
      label={`Workspace icon of ${name}`}
      testId="workspace-icon"
      save={async (next) => {
        const result = await updateWorkspaceAction({ workspaceId, icon: next });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }}
    />
  );
}
