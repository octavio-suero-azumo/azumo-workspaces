import { describe, expect, it } from "vitest";
import {
  contentDispositionAttachment,
  downloadFileName,
  downloadHeaders,
  safeContentType,
} from "@/server/uploads/download-headers";

// T-16 / AC-24 / DP7: download headers. Content-Disposition is always
// `attachment`, the file name is encoded per RFC 6266 / RFC 8187, and no
// header can be injected through a user-controlled display name.

/** Decode the RFC 8187 `filename*` value back to the name. */
function extendedFilename(header: string): string {
  const match = /filename\*=UTF-8''([^;\s]+)/.exec(header);
  if (!match) throw new Error(`no filename* in ${header}`);
  return decodeURIComponent(match[1]);
}

function asciiFilename(header: string): string {
  const match = /filename="([^"]*)"/.exec(header);
  if (!match) throw new Error(`no filename in ${header}`);
  return match[1];
}

describe("Content-Disposition (RFC 6266)", () => {
  it("plain ASCII name", () => {
    expect(contentDispositionAttachment("report.pdf")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
  });

  it("non-ASCII name: UTF-8 in filename*, ASCII fallback in filename", () => {
    const header = contentDispositionAttachment("Presupuesto año 2026.xlsx");
    expect(header.startsWith("attachment;")).toBe(true);
    expect(header).toContain("filename*=UTF-8''Presupuesto%20a%C3%B1o%202026.xlsx");
    expect(asciiFilename(header)).toBe("Presupuesto ano 2026.xlsx");
    expect(extendedFilename(header)).toBe("Presupuesto año 2026.xlsx");
  });

  it.each(["日本語 ファイル.pdf", "emoji 😀 notes.txt", "it's (v1)*.csv", "100% done; really.txt"])(
    "round-trips %j through filename* and keeps the header ASCII",
    (name) => {
      const header = contentDispositionAttachment(name);
      expect(extendedFilename(header)).toBe(name);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
      // RFC 8187 attr-char excludes these; they must be percent-encoded.
      const encoded = /filename\*=UTF-8''(\S+)/.exec(header)?.[1] ?? "";
      expect(encoded).not.toMatch(/['()*;" ]/);
    },
  );

  it("quotes and backslashes cannot break out of the quoted fallback", () => {
    const header = contentDispositionAttachment('a"b\\c.txt');
    expect(asciiFilename(header)).toBe("a_b_c.txt");
    expect(header.match(/"/g)).toHaveLength(2);
  });

  it("CR/LF and other control characters are removed (no header injection)", () => {
    const header = contentDispositionAttachment("evil\r\nSet-Cookie: session=1.txt");
    expect(header).not.toMatch(/[\r\n]/);
    expect(() => new Headers({ "Content-Disposition": header })).not.toThrow();
    expect(extendedFilename(header)).toBe("evil Set-Cookie: session=1.txt");
  });

  it("bidi overrides are removed (no disguised extensions)", () => {
    expect(downloadFileName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
  });

  it("path separators become underscores", () => {
    expect(downloadFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(downloadFileName("..\\secret.txt")).toBe(".._secret.txt");
  });

  it.each([[""], ["   "], ["\u0000‮"], [undefined], [42]])("an empty or invalid name %j falls back to 'download'", (name) => {
    expect(contentDispositionAttachment(name)).toBe("attachment; filename=\"download\"; filename*=UTF-8''download");
  });

  it("very long names are truncated to 200 code points", () => {
    expect(Array.from(downloadFileName("é".repeat(400))).length).toBe(200);
  });
});

describe("download response headers (AC-24)", () => {
  it("sets attachment, private no-cache, nosniff, a sandbox CSP, the stored type and the length", () => {
    const headers = downloadHeaders({ displayName: "W1 roadmap.pdf", contentType: "application/pdf", size: 2048 });
    expect(headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"W1 roadmap.pdf\"; filename*=UTF-8''W1%20roadmap.pdf",
    );
    expect(headers.get("Cache-Control")).toBe("private, no-cache");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(headers.get("Content-Type")).toBe("application/pdf");
    expect(headers.get("Content-Length")).toBe("2048");
  });

  it("omits Content-Length when the size is unknown", () => {
    expect(downloadHeaders({ displayName: "x", contentType: "text/plain", size: null }).has("Content-Length")).toBe(false);
  });

  it.each([
    ["application/pdf", "application/pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["text/html\r\nX-Evil: 1", "application/octet-stream"],
    ["", "application/octet-stream"],
    ["not a type", "application/octet-stream"],
    [undefined, "application/octet-stream"],
  ])("safeContentType(%j) → %j", (input, expected) => {
    expect(safeContentType(input)).toBe(expected);
  });
});
