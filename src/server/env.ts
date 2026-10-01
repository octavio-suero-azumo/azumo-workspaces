import { z } from "zod";

/**
 * Typed, fail-closed environment loader (R1.3, R6.2, AC-06).
 *
 * - `parseEnv(source)` validates an arbitrary env object (used by tests).
 * - `getEnv()` validates `process.env` once and caches the result.
 *
 * Error messages name the offending variables but never echo their values,
 * so secrets cannot leak through logs.
 *
 * No domain literal lives here: the allowed Google Workspace domain comes
 * only from `ALLOWED_GOOGLE_HD`.
 */

export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (P8)

export const DEFAULT_UPLOAD_ALLOWED_TYPES: readonly string[] = Object.freeze([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
]);

// Lowercase DNS hostname with at least two labels. Each label is 1-63 chars of
// [a-z0-9-], not starting or ending with '-'. Total length <= 253.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

// Concrete MIME type (no wildcards): type/subtype using RFC 6838 restricted chars.
const MIME_TOKEN = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
const MIME_RE = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}$`);

/** Treat unset and empty-string values the same way (both mean "not provided"). */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.length === 0 ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const allowedGoogleHd = z.preprocess(
  emptyToUndefined,
  z
    .string({ error: "is required (single lowercase hostname)" })
    .superRefine((value, ctx) => {
      if (value.includes("*")) {
        ctx.addIssue({ code: "custom", message: "must not contain a wildcard" });
        return;
      }
      if (value.includes(",") || /\s/.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: "must be a single domain (no commas or whitespace)",
        });
        return;
      }
      if (value !== value.toLowerCase()) {
        ctx.addIssue({ code: "custom", message: "must be lowercase" });
        return;
      }
      if (!HOSTNAME_RE.test(value)) {
        ctx.addIssue({ code: "custom", message: "must be a valid hostname" });
      }
    }),
);

const databaseUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .refine((value) => /^postgres(?:ql)?:\/\//.test(value), {
      message: "must be a postgres:// or postgresql:// URL (leave empty for local PGlite)",
    })
    .optional(),
);

const uploadMaxBytes = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^[1-9][0-9]*$/, { message: "must be a positive integer number of bytes" })
    .transform(Number)
    .refine(Number.isSafeInteger, { message: "is too large" })
    .optional()
    .transform((value) => value ?? DEFAULT_UPLOAD_MAX_BYTES),
);

const uploadAllowedTypes = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .transform((value, ctx) => {
      const types = value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0);
      if (types.length === 0) {
        ctx.addIssue({ code: "custom", message: "must list at least one MIME type" });
        return z.NEVER;
      }
      for (const type of types) {
        if (!MIME_RE.test(type)) {
          ctx.addIssue({
            code: "custom",
            message: "must be a comma-separated list of concrete MIME types (no wildcards)",
          });
          return z.NEVER;
        }
      }
      return Object.freeze([...new Set(types)]) as readonly string[];
    })
    .optional()
    .transform((value) => value ?? DEFAULT_UPLOAD_ALLOWED_TYPES),
);

const enableTestAuth = z.preprocess(
  emptyToUndefined,
  z
    .enum(["1", "true", "0", "false"], { error: "must be one of 1, true, 0, false" })
    .optional()
    .transform((value) => value === "1" || value === "true"),
);

const envSchema = z
  .object({
    // Set by Vercel in EVERY Vercel environment (build and runtime, preview
    // and production). Used to refuse the local PGlite fallback there (RV-F-06).
    VERCEL: optionalString,
    VERCEL_ENV: optionalString,
    DATABASE_URL: databaseUrl,
    // Local PGlite data directory (only used when DATABASE_URL is empty).
    // Defaults to `.pglite/` in the project root.
    PGLITE_DATA_DIR: optionalString,
    BETTER_AUTH_SECRET: optionalString,
    BETTER_AUTH_URL: optionalString,
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    ALLOWED_GOOGLE_HD: allowedGoogleHd,
    ENABLE_TEST_AUTH: enableTestAuth,
    BLOB_READ_WRITE_TOKEN: optionalString,
    UPLOAD_MAX_BYTES: uploadMaxBytes,
    UPLOAD_ALLOWED_TYPES: uploadAllowedTypes,
  })
  .superRefine((env, ctx) => {
    // Defense in depth for DP8 / AC-36: test-only auth can never be enabled in production.
    if (env.VERCEL_ENV === "production" && env.ENABLE_TEST_AUTH) {
      ctx.addIssue({
        code: "custom",
        path: ["ENABLE_TEST_AUTH"],
        message: "must not be enabled when VERCEL_ENV=production",
      });
    }
    // Review RV-C-07: in production the OAuth redirect URI and Better Auth's
    // trusted origin must come from explicit configuration, never be inferred
    // from request headers.
    if (env.VERCEL_ENV === "production") {
      if (!env.BETTER_AUTH_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["BETTER_AUTH_URL"],
          message: "is required when VERCEL_ENV=production",
        });
      } else if (!isAbsoluteHttpsUrl(env.BETTER_AUTH_URL)) {
        // Review RV-F-07: production must never issue cookies or OAuth
        // redirects over plain http.
        ctx.addIssue({
          code: "custom",
          path: ["BETTER_AUTH_URL"],
          message: "must be an absolute https:// URL when VERCEL_ENV=production",
        });
      }
    }
  });

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export type Env = z.output<typeof envSchema>;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class EnvValidationError extends Error {
  /** Human-readable issues, e.g. "ALLOWED_GOOGLE_HD: must be lowercase". Never contains values. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Validate an arbitrary env object. Throws `EnvValidationError` (fail closed)
 * when any variable is invalid, including a missing/empty/wildcard/list
 * `ALLOWED_GOOGLE_HD`.
 */
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join(".") : "env";
      return `${name}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/** Validated `process.env`, parsed once per process. Throws if invalid. */
export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}
