"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

/*
 * App shell (E1): a ~250 px sidebar next to the main column.
 * - Desktop: the sidebar can be collapsed (remembered per device in
 *   localStorage — a visual preference only) and reopened from the top bar.
 * - Mobile (< 768 px): the sidebar is an off-canvas drawer with a backdrop;
 *   Escape or navigating to another path closes it.
 */

interface SidebarState {
  collapsed: boolean;
  mobileOpen: boolean;
  toggle: () => void;
  closeMobile: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

const STORAGE_KEY = "azumo-sidebar-collapsed";

export function useSidebar(): SidebarState {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used inside <AppShell>");
  return value;
}

function isMobile(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

// The collapsed preference is an external store (localStorage, shared by
// tabs); the in-memory copy keeps working when storage is unavailable.
let collapsedCache: boolean | null = null;
const collapsedListeners = new Set<() => void>();

function getCollapsed(): boolean {
  if (collapsedCache === null) {
    try {
      collapsedCache = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      collapsedCache = false;
    }
  }
  return collapsedCache;
}

function getServerCollapsed(): boolean {
  return false;
}

function subscribeCollapsed(listener: () => void): () => void {
  collapsedListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    collapsedCache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    collapsedListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function setCollapsed(value: boolean) {
  collapsedCache = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage unavailable: the preference lasts until the next reload.
  }
  for (const listener of collapsedListeners) listener();
}

export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, getCollapsed, getServerCollapsed);
  const pathname = usePathname();
  // The drawer is open for the path it was opened on: navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const mobileOpen = openOn !== null && openOn === pathname;

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const toggle = useCallback(() => {
    if (isMobile()) {
      setOpenOn((current) => (current === pathname ? null : pathname));
      return;
    }
    setCollapsed(!getCollapsed());
  }, [pathname]);

  const closeMobile = useCallback(() => setOpenOn(null), []);
  const value = useMemo(() => ({ collapsed, mobileOpen, toggle, closeMobile }), [collapsed, mobileOpen, toggle, closeMobile]);

  return (
    <SidebarContext.Provider value={value}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div
        className="app-shell"
        data-sidebar={collapsed ? "collapsed" : "expanded"}
        data-mobile-open={mobileOpen ? "true" : "false"}
      >
        {sidebar}
        <div className="app-backdrop" aria-hidden="true" onClick={closeMobile} />
        <div className="app-main">{children}</div>
      </div>
    </SidebarContext.Provider>
  );
}
