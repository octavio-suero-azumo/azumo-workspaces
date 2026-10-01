import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { authSchema, user as userTable } from "@/server/db/schema";
import type { Env } from "@/server/env";
import {
  evaluateGoogleIdentity,
  GOOGLE_IDENTITY_REJECTION_MESSAGES,
  type GoogleIdentityClaims,
} from "./domain-guard";

/**
 * Better Auth configuration (T-03a, T-06a).
 *
 * Sign-in is Google only (R1.1, AC-36): no email/password, no other provider,
 * no test plugin. The allowed Workspace domain comes only from
 * `ALLOWED_GOOGLE_HD` (R1.3). The domain rule (R1.2) is enforced in layers,
 * all server-side:
 *
 * 1. Google provider `hd` option: Better Auth's built-in check rejects ID
 *    tokens whose `hd` claim differs or is missing (we do NOT override
 *    `getUserInfo`, which would disable that check).
 * 2. `user.validateUserInfo`: re-checks the fresh ID-token claims
 *    (`hd`, `email_verified`) on user creation, account linking and every
 *    returning OAuth sign-in. Rejects any non-Google method.
 * 3. `databaseHooks.user.create.before`: checks the mapped user (the `hd`
 *    claim captured by `mapProfileToUser` + `emailVerified`) → no user row.
 * 4. `databaseHooks.session.create.before`: re-reads the stored user and
 *    checks its `googleHd`/`emailVerified` against the CURRENT env value →
 *    no session row (covers returning users, who skip user creation; RK-1).
 *
 * Hooks abort by throwing an `APIError` (403). In Better Auth 1.7.6
 * `createWithHooks` stops before the insert when a `before` hook throws or
 * returns `false`; throwing is used so the OAuth callback redirects to the
 * error URL with a specific `?error=<code>`.
 *
 * Attack surface reduction (review RV-C-01), verified against the 1.7.6 source:
 * - `account.accountLinking.enabled = false`: a second Google identity (new
 *   `sub`) that reuses an existing user's email is refused in
 *   `handleOAuthUserInfo` ("account not linked") instead of being linked.
 * - `socialProviders.google.disableIdTokenSignIn = true`: `POST
 *   /sign-in/social` with a client-supplied `idToken` is refused
 *   (`ID_TOKEN_NOT_SUPPORTED`) before any token verification. Only the
 *   server-side authorization-code flow remains.
 * - `disabledPaths`: the router answers 404 for account-linking, profile
 *   update and provider-token endpoints the app never uses. This only blocks
 *   HTTP access; server-side `auth.api.*` calls are unaffected (and
 *   `user.update.before` still guards `googleHd`).
 */

/**
 * Better Auth HTTP endpoints the app does not use, disabled at the router
 * (paths are relative to the auth base path, e.g. `/api/auth`).
 */
export const AUTH_DISABLED_PATHS = Object.freeze([
  "/link-social",
  "/unlink-account",
  "/update-user",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
] as const);

export class AuthConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    // Names only, never values.
    super(`Auth is not configured. Missing: ${missing.join(", ")}`);
    this.name = "AuthConfigError";
    this.missing = missing;
  }
}

export interface AuthDeps {
  db: AppDatabase;
  env: Env;
}

/** Where rejected OAuth sign-ins land; the page renders `?error=<code>`. */
export const SIGN_IN_PATH = "/sign-in";

function reject(claims: GoogleIdentityClaims, allowedHd: string): void {
  const verdict = evaluateGoogleIdentity(claims, allowedHd);
  if (!verdict.ok) {
    throw new APIError("FORBIDDEN", {
      code: verdict.reason,
      message: GOOGLE_IDENTITY_REJECTION_MESSAGES[verdict.reason],
    });
  }
}

export function buildAuthOptions({ db, env }: AuthDeps) {
  const missing = (["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const).filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw new AuthConfigError(missing);
  }
  const allowedHd = env.ALLOWED_GOOGLE_HD;

  return {
    appName: "Azumo Workspaces",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    // RV-C-01: never link a second identity to an existing user.
    account: { accountLinking: { enabled: false } },
    // RV-C-01: unused endpoints answer 404 (router-level).
    disabledPaths: [...AUTH_DISABLED_PATHS],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID as string,
        clientSecret: env.GOOGLE_CLIENT_SECRET as string,
        // Account-picker hint AND Better Auth's built-in ID-token `hd` check.
        hd: allowedHd,
        prompt: "select_account",
        // RV-C-01: only the authorization-code flow; no client-supplied ID tokens.
        disableIdTokenSignIn: true,
        // Persist the `hd` claim so the session hook can re-check it later.
        mapProfileToUser: (profile) => ({
          googleHd: typeof profile.hd === "string" ? profile.hd.toLowerCase() : null,
        }),
      },
    },
    user: {
      additionalFields: {
        // `input` must stay enabled: Better Auth drops `input: false` fields
        // coming from `mapProfileToUser`. Client updates are blocked by the
        // `user.update.before` hook below.
        googleHd: { type: "string", required: false },
      },
      validateUserInfo: ({ source }) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "google") {
          return { error: "provider_not_allowed", errorDescription: "Only Google sign-in is allowed." };
        }
        const profile = source.oauth.profile ?? {};
        const verdict = evaluateGoogleIdentity(
          { hd: profile.hd, emailVerified: profile.email_verified },
          allowedHd,
        );
        if (!verdict.ok) {
          return {
            error: verdict.reason,
            errorDescription: GOOGLE_IDENTITY_REJECTION_MESSAGES[verdict.reason],
          };
        }
      },
    },
    session: {
      // Disabled so sign-out and revocation take effect on the next request
      // (architecture §4.9, AC-07).
      cookieCache: { enabled: false },
    },
    onAPIError: { errorURL: SIGN_IN_PATH },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            reject({ hd: user.googleHd, emailVerified: user.emailVerified }, allowedHd);
          },
        },
        update: {
          before: async (data) => {
            if ("googleHd" in data) {
              throw new APIError("FORBIDDEN", {
                code: "field_immutable",
                message: "This field cannot be changed.",
              });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [stored] = await db
              .select({ googleHd: userTable.googleHd, emailVerified: userTable.emailVerified })
              .from(userTable)
              .where(eq(userTable.id, session.userId))
              .limit(1);
            if (!stored) {
              throw new APIError("FORBIDDEN", { code: "user_not_found", message: "Unknown user." });
            }
            reject({ hd: stored.googleHd, emailVerified: stored.emailVerified }, allowedHd);
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(buildAuthOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;
