"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog } from "@/components/ui/dialog";
import { IconPicker } from "@/components/ui/icon-picker";
import { displayIcon } from "@/lib/icons";

/*
 * A page or workspace icon. For roles that may change it, the icon is a
 * button that opens the curated picker (E2); for others it is plain text.
 * `save` calls the server action, which validates the value again.
 */

type SaveResult = { ok: true } | { ok: false; error: { message: string } };

export interface IconButtonPickerProps {
  icon: string | null;
  defaultIcon: string;
  canEdit: boolean;
  label: string;
  size?: "lg" | "xl";
  save: (icon: string | null) => Promise<SaveResult>;
  onSaved?: (icon: string | null) => void;
  testId?: string;
}

export function IconButtonPicker({ icon, defaultIcon, canEdit, label, size = "xl", save, onSaved, testId }: IconButtonPickerProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(icon);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shown = displayIcon(current, defaultIcon);
  const sizeClass = size === "xl" ? "text-5xl h-16 w-16" : "text-3xl h-12 w-12";

  if (!canEdit) {
    return (
      <span aria-hidden="true" className={`inline-flex items-center justify-center ${sizeClass}`} data-testid={testId}>
        {shown}
      </span>
    );
  }

  function pick(next: string | null) {
    setError(null);
    startTransition(async () => {
      const result = await save(next);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCurrent(next);
      onSaved?.(next);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${label}: ${shown}. Change icon`}
        className={`inline-flex items-center justify-center rounded-lg hover:bg-hover ${sizeClass}`}
        data-testid={testId}
      >
        <span aria-hidden="true">{shown}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Change icon`} description={label} size="sm" testId="icon-dialog">
        <IconPicker current={current} defaultIcon={defaultIcon} disabled={pending} onPick={pick} />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
