import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { UPLOADS_NOT_CONFIGURED_MESSAGE } from "@/lib/attachment-rules";
import { requireSession } from "@/server/authz/session";
import { authorizeUploadRequest, INVALID_UPLOAD_REQUEST_MESSAGE } from "@/server/data/attachments";
import { getDataContext } from "@/server/data/context";
import { ServiceUnavailableError, ValidationError } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { getUploadConfig, getUploadLimits } from "@/server/uploads/config";

/**
 * Client-upload token route (T-15, AC-22, AC-23, AC-38; architecture §7).
 *
 * Order of checks (each failure is a typed error mapped by `errorResponse`):
 * 1. `requireSession()` → 401. Done before anything else (the Blob SDK reads
 *    its token before calling `onBeforeGenerateToken`, so the session cannot
 *    be checked inside the callback first; the effect is the same: no token
 *    is ever generated without a session).
 * 2. Body must be a `blob.generate-client-token` event → 400. Upload-completed
 *    callbacks are not used (they cannot reach localhost; the browser calls the
 *    `registerUpload` server action instead), so they are rejected.
 * 3. `onBeforeGenerateToken` → `authorizeUploadRequest`: page from
 *    `clientPayload` authorized with `attachment.add` (Viewer 403, non-member
 *    404), pathname VALIDATED against `ws/{workspaceId}/pg/{pageId}/` of the
 *    authorized page (403 otherwise; the SDK signs the client's pathname and
 *    cannot rewrite it, RV-08), declared size/type checked (P8, 400).
 * 4. The token carries the P8 limits (`maximumSizeInBytes`,
 *    `allowedContentTypes`) and `addRandomSuffix`, so the Blob service
 *    enforces them on the actual upload.
 *
 * Without `BLOB_READ_WRITE_TOKEN` the same authorization runs, then 503
 * "Uploads are not configured" (fail closed; the rest of the app works).
 */

export const dynamic = "force-dynamic";

/** Short-lived client tokens: enough to start a 10 MB upload. */
const CLIENT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const tokenEvent = z.object({
  type: z.literal("blob.generate-client-token"),
  payload: z.object({
    pathname: z.string().max(1024),
    clientPayload: z.string().max(4096).nullable(),
    multipart: z.boolean(),
  }),
});

type TokenEvent = z.infer<typeof tokenEvent>;

async function readTokenEvent(request: Request): Promise<TokenEvent> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  const parsed = tokenEvent.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError(INVALID_UPLOAD_REQUEST_MESSAGE);
  }
  return parsed.data;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await requireSession();
    const event = await readTokenEvent(request);
    const ctx = await getDataContext(session);

    const config = getUploadConfig();
    if (!config) {
      // Same gate first, so the answer never depends on configuration for
      // pages the requester cannot use.
      await authorizeUploadRequest(ctx, event.payload, getUploadLimits());
      throw new ServiceUnavailableError(UPLOADS_NOT_CONFIGURED_MESSAGE);
    }

    const result = await handleUpload({
      token: config.token,
      request,
      body: event satisfies HandleUploadBody,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        await authorizeUploadRequest(ctx, { pathname, clientPayload }, config);
        return {
          allowedContentTypes: [...config.allowedTypes],
          maximumSizeInBytes: config.maxBytes,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + CLIENT_TOKEN_TTL_MS,
        };
      },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
