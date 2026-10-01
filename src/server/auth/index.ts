import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { createAuth, type Auth } from "./config";

export { type Auth, AuthConfigError, SIGN_IN_PATH } from "./config";

// Created lazily on first use (not at import), so `next build` never needs
// runtime secrets and a misconfigured deployment fails closed per request.
const globalForAuth = globalThis as typeof globalThis & { __azumoAuth?: Promise<Auth> };

/** The app's Better Auth instance. Throws (fail closed) when env is invalid. */
export function getAuth(): Promise<Auth> {
  if (!globalForAuth.__azumoAuth) {
    globalForAuth.__azumoAuth = (async () => createAuth({ db: await getDb(), env: getEnv() }))().catch(
      (error: unknown) => {
        globalForAuth.__azumoAuth = undefined;
        throw error;
      },
    );
  }
  return globalForAuth.__azumoAuth;
}
