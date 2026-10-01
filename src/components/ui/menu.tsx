"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/*
 * Accessible dropdown menu (WAI-ARIA menu button pattern):
 * - the trigger has aria-haspopup / aria-expanded;
 * - arrow keys, Home and End move between items; Escape and Tab close it;
 * - closing returns focus to the trigger; a click outside closes it.
 * Items are real actions; nothing here is decorative.
 */

export type MenuItem =
  | {
      kind?: "action";
      key: string;
      label: string;
      icon?: ReactNode;
      hint?: string;
      danger?: boolean;
      testId?: string;
      onSelect: () => void;
    }
  | {
      kind: "checkbox";
      key: string;
      label: string;
      checked: boolean;
      testId?: string;
      onSelect: () => void;
    }
  | {
      kind: "radio";
      key: string;
      label: string;
      checked: boolean;
      testId?: string;
      onSelect: () => void;
    };

export interface MenuSection {
  key: string;
  label?: string;
  items: MenuItem[];
}

export interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  trigger: ReactNode;
  sections: MenuSection[];
  align?: "start" | "end";
  triggerClassName?: string;
  testId?: string;
}

export function Menu({ label, trigger, sections, align = "end", triggerClassName, testId }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => list[(next + list.length) % list.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(list.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        className={triggerClassName ?? "ui-icon-button"}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={`ui-menu absolute top-full z-40 mt-1 min-w-56 ${align === "end" ? "right-0" : "left-0"}`}
          data-testid={testId ? `${testId}-list` : undefined}
        >
          {sections.map((section, sectionIndex) => (
            <div key={section.key} role="group" aria-label={section.label} className={sectionIndex > 0 ? "ui-menu-separator" : ""}>
              {section.label ? <p className="ui-menu-label">{section.label}</p> : null}
              {section.items.map((item) => {
                const role = item.kind === "checkbox" ? "menuitemcheckbox" : item.kind === "radio" ? "menuitemradio" : "menuitem";
                const checked = item.kind === "checkbox" || item.kind === "radio" ? item.checked : undefined;
                const danger = item.kind === undefined || item.kind === "action" ? item.danger : false;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role={role}
                    aria-checked={checked}
                    tabIndex={-1}
                    data-menu-item=""
                    data-testid={item.testId}
                    className={`ui-menu-item ${danger ? "ui-menu-item-danger" : ""}`}
                    onClick={() => {
                      close(true);
                      item.onSelect();
                    }}
                  >
                    <span className="flex w-5 shrink-0 justify-center" aria-hidden="true">
                      {item.kind === "checkbox" || item.kind === "radio"
                        ? item.checked
                          ? "✓"
                          : ""
                        : (item.icon ?? null)}
                    </span>
                    <span className="flex-1 truncate text-left">{item.label}</span>
                    {(item.kind === undefined || item.kind === "action") && item.hint ? (
                      <span className="ui-menu-hint">{item.hint}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
