"use client";

import { useActionState } from "react";
import { PlusIcon } from "@/components/nav-icons";
import { PAGE_TITLE_MAX } from "@/lib/page-content-rules";
import { createPageAction } from "./p/actions";

type State = Awaited<ReturnType<typeof createPageAction>> | null;

/**
 * "New page" form (T-10). Rendered only for roles that may create pages
 * (R3.4); the server enforces `page.create` regardless (R3.2). On success the
 * action redirects to the new page. An empty title creates "Untitled".
 */
export function CreatePageForm({ workspaceId }: { workspaceId: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(createPageAction, null);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" aria-label="New page" data-testid="create-page-form">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <label className="sr-only" htmlFor={`new-page-title-${workspaceId}`}>
        New page title
      </label>
      <input
        id={`new-page-title-${workspaceId}`}
        name="title"
        maxLength={PAGE_TITLE_MAX}
        placeholder="Page title"
        aria-label="Page title"
        className="ui-input max-w-xs flex-1"
      />
      <button type="submit" disabled={pending} className="ui-button-primary">
        <PlusIcon />
        {pending ? "Creating…" : "Create page"}
      </button>
      {state && !state.ok ? (
        <p role="alert" className="basis-full text-sm text-danger">
          {state.error.message}
        </p>
      ) : null}
    </form>
  );
}
