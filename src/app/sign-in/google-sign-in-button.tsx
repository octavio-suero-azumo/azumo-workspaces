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
    <div className="flex w-full flex-col items-center gap-2">
      <button type="button" onClick={signIn} disabled={pending} className="ui-button-secondary w-full justify-center py-2">
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          Could not start Google sign-in. Please try again.
        </p>
      ) : null}
    </div>
  );
}
