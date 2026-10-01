"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useSidebar } from "@/components/app-shell";
import { ChevronRightIcon, SidebarIcon } from "@/components/nav-icons";

/*
 * Compact top bar of every app screen (E1): sidebar toggle, breadcrumbs and a
 * right-hand slot for the screen's actions. Crumbs truncate instead of
 * widening the page (UI-02); the full name stays available as a tooltip.
 */

export interface Crumb {
  label: string;
  href?: string;
  icon?: string;
}

export function TopBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  const { collapsed, mobileOpen, toggle } = useSidebar();
  return (
    <header className="sticky top-0 z-30 flex h-11 shrink-0 items-center gap-2 bg-bg px-3">
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Open sidebar" : "Toggle sidebar"}
        aria-expanded={!collapsed || mobileOpen}
        className={`ui-icon-button ${collapsed ? "" : "md:hidden"}`}
        data-testid="sidebar-toggle"
      >
        <SidebarIcon />
      </button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            const content = (
              <>
                {crumb.icon ? (
                  <span aria-hidden="true" className="shrink-0">
                    {crumb.icon}
                  </span>
                ) : null}
                <span className="truncate">{crumb.label}</span>
              </>
            );
            return (
              <li key={`${index}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <ChevronRightIcon className="shrink-0 text-muted" width={12} height={12} /> : null}
                {crumb.href && !last ? (
                  <Link
                    href={crumb.href}
                    title={crumb.label}
                    className="flex min-w-0 max-w-[16rem] items-center gap-1 rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg"
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    title={crumb.label}
                    aria-current={last ? "page" : undefined}
                    className="flex min-w-0 max-w-[20rem] items-center gap-1 px-1 py-0.5 text-fg"
                  >
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}
