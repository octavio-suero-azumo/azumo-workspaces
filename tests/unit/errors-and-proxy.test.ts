import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createActionWrapper } from "@/server/action";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthenticatedError,
  ValidationError,
} from "@/server/errors";
import { errorResponse, statusForError } from "@/server/http";
import { proxy } from "@/proxy";

describe("error → HTTP status mapping (architecture §4.6)", () => {
  it.each([
    [new UnauthenticatedError(), 401],
    [new ForbiddenError(), 403],
    [new NotFoundError(), 404],
    [new ConflictError(), 409],
    [new ValidationError(), 400],
    [new ServiceUnavailableError(), 503],
    [z.string().safeParse(1).error, 400],
    [new Error("boom with internal details"), 500],
  ])("%s → %i", (error, status) => {
    expect(statusForError(error)).toBe(status);
  });

  it("never leaks internal error details or stacks in the body", async () => {
    const response = errorResponse(new Error("db password=hunter2 at /srv/x.ts:1"));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("x.ts");
    expect(JSON.parse(body)).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });
});

describe("action() wrapper result mapping", () => {
  const signedIn = createActionWrapper(async () => ({ userId: "u1" }));

  it("maps typed errors to their code", async () => {
    const run = signedIn(async () => {
      throw new ForbiddenError();
    });
    await expect(run()).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "You do not have permission to do this." },
    });
  });

  it("maps unknown errors to INTERNAL without details", async () => {
    const run = signedIn(async () => {
      throw new Error("secret detail");
    });
    const result = await run();
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Something went wrong." } });
  });

  it("returns UNAUTHENTICATED when the resolver throws and never runs the handler", async () => {
    let ran = false;
    const signedOut = createActionWrapper(async () => {
      throw new UnauthenticatedError();
    });
    const result = await signedOut(async () => {
      ran = true;
    })();
    expect(ran).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });
});

describe("proxy optimistic redirect (not authorization)", () => {
  it("redirects to /sign-in when there is no session cookie", () => {
    const response = proxy(new NextRequest("http://localhost:3000/workspaces/abc"));
    expect([307, 308]).toContain(response.status);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });

  it("lets the request through when a session cookie is present", () => {
    const request = new NextRequest("http://localhost:3000/", {
      headers: { cookie: "better-auth.session_token=anything.sig" },
    });
    const response = proxy(request);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
