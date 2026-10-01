"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restorePageAction } from "@/app/(app)/w/[workspaceId]/p/actions";
import { RestoreIcon } from "@/components/nav-icons";

/** Restore a page from Trash (Owner/Editor; the server re-checks the CURRENT role). */
export function RestoreButton({ pageId, title }: { pageId: string; title: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function restore() {
    setError(null);
    startTransition(async () => {
      const result = await restorePageAction({ pageId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.push(`/w/${result.data.workspaceId}/p/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={restore}
        disabled={pending}
        className="ui-button-secondary"
        aria-label={`Restore ${title}`}
        data-testid="trash-restore"
      >
        <RestoreIcon />
        {pending ? "Restoring…" : "Restore"}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
