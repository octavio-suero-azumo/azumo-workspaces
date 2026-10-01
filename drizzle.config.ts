import { defineConfig } from "drizzle-kit";

// Versioned migrations (DP9). `npm run db:generate` writes SQL into `drizzle/`
// and needs no database connection.
//
// Migrations are applied with the guarded runner, NOT with `drizzle-kit
// migrate` (review RV-F-01):
//   npm run db:migrate:prod   DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL; never PGlite
//   npm run db:migrate:local  local PGlite, explicitly
//   npm run db:migrate        remote when a URL is set, otherwise refuses
//
// This config therefore never falls back to local PGlite: without a URL it
// carries no credentials, so drizzle-kit commands that need a database
// (migrate, push, studio) fail instead of silently targeting `.pglite/`.
const schema = "./src/server/db/schema.ts";
const out = "./drizzle";
const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

export default databaseUrl
  ? defineConfig({ schema, out, dialect: "postgresql", dbCredentials: { url: databaseUrl } })
  : defineConfig({ schema, out, dialect: "postgresql" });
