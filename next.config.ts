import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise inject a managed block into the root CLAUDE.md
  // (project rules file that must stay untouched). Opt out declaratively.
  agentRules: false,
  // PGlite ships WASM/data files that must be loaded from node_modules at
  // runtime rather than bundled (local dev/tests only; production uses Neon).
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
