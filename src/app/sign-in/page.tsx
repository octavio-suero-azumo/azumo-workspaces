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
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Sign in to Azumo Workspaces</h1>
      <p className="text-sm text-neutral-500">Use your corporate Google Workspace account.</p>
      {message ? (
        <p role="alert" data-testid="sign-in-error" className="max-w-md text-center text-sm text-red-700">
          {message}
        </p>
      ) : null}
      <GoogleSignInButton />
    </main>
  );
}
