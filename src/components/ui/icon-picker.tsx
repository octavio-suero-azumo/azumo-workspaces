"use client";

import { ICON_CHOICES } from "@/lib/icons";

/*
 * Curated emoji grid (src/lib/icons.ts). The server accepts only these values;
 * "Reset" stores null, which renders the default icon.
 */

export interface IconPickerProps {
  current: string | null;
  defaultIcon: string;
  disabled?: boolean;
  onPick: (icon: string | null) => void;
}

export function IconPicker({ current, defaultIcon, disabled, onPick }: IconPickerProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="icon-picker">
      <div role="listbox" aria-label="Icons" className="grid grid-cols-8 gap-1">
        {ICON_CHOICES.map((icon) => {
          const selected = icon === current;
          return (
            <button
              key={icon}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={`Icon ${icon}`}
              disabled={disabled}
              onClick={() => onPick(icon)}
              className={`flex aspect-square items-center justify-center rounded-md text-xl hover:bg-hover disabled:opacity-50 ${
                selected ? "bg-hover ring-1 ring-[var(--border-strong)]" : ""
              }`}
            >
              {icon}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted">
          Default: <span aria-hidden="true">{defaultIcon}</span>
        </span>
        <button
          type="button"
          disabled={disabled || current === null}
          onClick={() => onPick(null)}
          className="ui-button-secondary"
          data-testid="icon-reset"
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
