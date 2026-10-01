import { requireSession } from "@/server/authz/session";
import { getAttachmentDownload } from "@/server/data/attachments";
import { getDataContext } from "@/server/data/context";
import { NotFoundError } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { openUploadedBlob } from "@/server/uploads/blob-store";
import { requireUploadConfig } from "@/server/uploads/config";
import { downloadHeaders } from "@/server/uploads/download-headers";

/**
 * Authorizing download route (T-16, R4.3, AC-24, DP7).
 *
 * 1. `requireSession()` → 401.
 * 2. `authorize(attachment, page.view)` → non-member 404 (DP2); every member
 *    may download.
 * 3. Uploads not configured → 503.
 * 4. The private blob is fetched server-side and STREAMED through this
 *    response. The blob URL is never sent to the browser (no redirect, no
 *    URL in any header or body).
 *
 * Headers: `Content-Disposition: attachment` with an RFC 6266 file name,
 * `Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`, and
 * the content type validated at registration.
 */

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext<"/api/files/[attachmentId]">): Promise<Response> {
  try {
    const session = await requireSession();
    const { attachmentId } = await context.params;
    const ctx = await getDataContext(session);
    const file = await getAttachmentDownload(ctx, { attachmentId });

    const config = requireUploadConfig();
    const blob = await openUploadedBlob(file.blobPathname, config);
    if (!blob) {
      throw new NotFoundError();
    }
    return new Response(blob.stream, {
      status: 200,
      headers: downloadHeaders({ displayName: file.displayName, contentType: file.contentType, size: blob.size }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
