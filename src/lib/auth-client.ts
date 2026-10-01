"use client";

import { createAuthClient } from "better-auth/react";

// Browser-side Better Auth client. Talks to /api/auth on the same origin.
export const authClient = createAuthClient();
