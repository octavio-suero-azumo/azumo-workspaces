import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError } from "@/server/env";

// AC-06 / TC-05 (b): with ALLOWED_GOOGLE_HD unset, empty or "*", the auth
// route handler (the sign-in endpoint) fails closed. Next.js turns the thrown
// error into a 500, so the endpoint never answers 2xx. The env is invalid in
// every case, so no database is ever opened.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function callSignIn(): Promise<Response> {
  const { POST } = await import("@/app/api/auth/[...all]/route");
  return POST(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
  );
}

describe("auth route fails closed on invalid ALLOWED_GOOGLE_HD", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["wildcard", "*"],
  ])("rejects when ALLOWED_GOOGLE_HD is %s", async (_label, value) => {
    vi.stubEnv("ALLOWED_GOOGLE_HD", value);
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-placeholder-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-placeholder-client-secret");
    vi.stubEnv("DATABASE_URL", "");

    // resetModules gives the route a fresh env module, so compare by name.
    await expect(callSignIn()).rejects.toMatchObject({ name: EnvValidationError.name });
  });
});
