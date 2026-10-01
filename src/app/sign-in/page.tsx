import type { Metadata } from "next";
import { GOOGLE_IDENTITY_REJECTION_MESSAGES } from "@/server/auth/domain-guard";
import { GoogleSignInButton } from "./google-sign-in-button";

export const metadata: Metadata = { title: "Sign in · Azumo Workspaces" };

const DOMAIN_REJECTED = GOOGLE_IDENTITY_REJECTION_MESSAGES.hd_mismatch;

// Error codes Better Auth appends as `?error=<code>` when a sign-in is refused.
const MESSAGES: Readonly<Record<string, string>> = {
  ...GOOGLE_IDENTITY_REJECTION_MESSAGES,
  // Better Auth's built-in `hd` check refuses the ID token with this code.
  unable_to_get_user_info: DOMAIN_REJECTED,
  provider_not_allowed: "Only Google sign-in is allowed.",
  access_denied: "Google sign-in was cancelled.",
};

const GENERIC_ERROR = "Sign-in failed or was rejected. Use your corporate Google account and try again.";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { error } = await searchParams;
  const code = typeof error === "string" ? error : undefined;
  const message = code ? (Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : GENERIC_ERROR) : undefined;

  return (
    <main className="flex min-h-dvh flex-1 flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-lg bg-sidebar text-2xl">
          📁
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">Sign in to Azumo Workspaces</h1>
          <p className="text-sm text-muted">Use your corporate Google Workspace account.</p>
        </div>
        {message ? (
          <p role="alert" data-testid="sign-in-error" className="w-full rounded-md bg-hover px-3 py-2 text-sm text-danger">
            {message}
          </p>
        ) : null}
        <GoogleSignInButton />
      </div>
    </main>
  );
}
