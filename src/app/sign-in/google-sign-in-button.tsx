"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setPending(true);
    setFailed(false);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/sign-in",
    });
    // On success the browser is redirected to Google; only errors return here.
    if (result.error) {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60"
      >
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {failed ? (
        <p role="alert" className="text-sm text-red-700">
          Could not start Google sign-in. Please try again.
        </p>
      ) : null}
    </div>
  );
}
