"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "@/components/nav-icons";

/*
 * Modal dialog on the native <dialog> element (`showModal()`): the browser
 * traps focus inside, closes on Escape and marks the rest of the page inert.
 * Focus returns to the element that opened it.
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Wider layout for content-heavy dialogs. */
  size?: "sm" | "md" | "lg";
  testId?: string;
}

export function Dialog({ open, onClose, title, description, children, size = "md", testId }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      returnFocus.current?.focus();
      returnFocus.current = null;
      onClose();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-testid={testId}
      className={`ui-dialog w-[calc(100vw-2rem)] ${width}`}
      onClick={(event) => {
        // Click on the backdrop (the <dialog> element itself) closes it.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {open ? (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description ? (
                <div id={descriptionId} className="text-sm text-muted">
                  {description}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => ref.current?.close()}
              className="ui-icon-button -mr-1 -mt-1"
            >
              <CloseIcon />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
