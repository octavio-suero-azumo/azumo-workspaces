import { join } from "node:path";

/** Gitignored directory for Playwright storageState files (`/playwright/.auth/`). */
export const AUTH_DIR = join(__dirname, "..", "..", "..", "playwright", ".auth");

/** Fixture ids written by global setup for the specs. */
export const FIXTURES_FILE = join(AUTH_DIR, "fixtures.json");

export function storageStatePath(userKey: string): string {
  return join(AUTH_DIR, `${userKey}.json`);
}
