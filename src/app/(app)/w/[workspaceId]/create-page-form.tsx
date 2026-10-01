"use client";

import { useActionState } from "react";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { createPageAction } from "./p/actions";

type State = Awaited<ReturnType<typeof createPageAction>> | null;

/**
 * "New page" form (T-10). Rendered only for roles that may create pages
 * (R3.4); the server enforces `page.create` regardless (R3.2). On success the
 * action redirects to the new page.
 */
export function CreatePageForm({ workspaceId }: { workspaceId: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(createPageAction, null);

  return (
    <form
      action={formAction}
      className="flex flex-wrap items-end gap-2"
      aria-label="New page"
      data-testid="create-page-form"
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
        New page
        <input
          name="title"
          required
          maxLength={PAGE_TITLE_MAX}
          placeholder="Page title"
          className="rounded border border-neutral-300 px-2 py-1 text-sm font-normal"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create page"}
      </button>
      {state && !state.ok ? (
        <p role="alert" className="basis-full text-xs text-red-700">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
