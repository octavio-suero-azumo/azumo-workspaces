import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_KINDS,
  buildUploadPathname,
  FILE_TYPE_NOT_ALLOWED_MESSAGE,
  fileDownloadPath,
  fileTooLargeMessage,
  formatBytes,
  isAllowedContentType,
  isValidUploadFileSegment,
  normalizeContentType,
  sanitizeDisplayName,
  toUploadFileSegment,
  uploadPathPrefix,
  uploadProblem,
} from "@/lib/attachment-rules";
import { DEFAULT_UPLOAD_ALLOWED_TYPES, DEFAULT_UPLOAD_MAX_BYTES } from "@/server/env";

// Pure attachment rules shared by schema, server and upload UI (T-13, T-15;
// P2, P8, RV-08). The server enforces them; the browser only pre-checks.

const W = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const LIMITS = { maxBytes: DEFAULT_UPLOAD_MAX_BYTES, allowedTypes: DEFAULT_UPLOAD_ALLOWED_TYPES };

describe("attachment kinds (P2 = uploads only)", () => {
  it("allows exactly 'upload'", () => {
    expect([...ATTACHMENT_KINDS]).toEqual(["upload"]);
  });
});

describe("upload pathname layout ws/{workspaceId}/pg/{pageId}/{file}", () => {
  it("builds the prefix and the full pathname", () => {
    expect(uploadPathPrefix(W, P)).toBe(`ws/${W}/pg/${P}/`);
    expect(buildUploadPathname(W, P, "Quarterly Report (final).PDF")).toBe(`ws/${W}/pg/${P}/Quarterly-Report-final.pdf`);
  });

  it.each([
    ["Quarterly Report (final).PDF", "Quarterly-Report-final.pdf"],
    ["année 2026 — résumé.docx", "annee-2026-resume.docx"],
    ["", "file"],
    [".env", "env"],
    ["no-extension", "no-extension"],
    ["archive.tar.gz", "archive-tar.gz"],
    ["日本語.pdf", "file.pdf"],
  ])("toUploadFileSegment(%j) → %j", (input, expected) => {
    expect(toUploadFileSegment(input)).toBe(expected);
  });

  it.each([
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "a/b/c.txt",
    "evil‮fdp.exe",
    "line\r\nbreak.txt",
    `${"x".repeat(500)}.pdf`,
    ".",
    "..",
    "---.pdf",
  ])("every file name %j becomes ONE safe segment (no slash, no '..')", (input) => {
    const segment = toUploadFileSegment(input);
    expect(isValidUploadFileSegment(segment)).toBe(true);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("..");
    expect(segment.length).toBeLessThanOrEqual(91);
  });

  it.each([
    ["report-AbC123xyz.pdf", true],
    ["a", true],
    ["x".repeat(200), true],
    ["x".repeat(201), false],
    ["", false],
    ["a/b.pdf", false],
    ["..", false],
    ["a..b.pdf", false],
    [".hidden", false],
    ["-dash.pdf", false],
    ["space name.pdf", false],
    ["tab\tname.pdf", false],
  ])("isValidUploadFileSegment(%j) === %s", (segment, valid) => {
    expect(isValidUploadFileSegment(segment)).toBe(valid);
  });

  it("the download path is always the app route", () => {
    expect(fileDownloadPath(P)).toBe(`/api/files/${P}`);
  });
});

describe("content types (P8 allowlist)", () => {
  it.each([
    ["Text/Plain; charset=UTF-8", "text/plain"],
    ["  APPLICATION/PDF ", "application/pdf"],
    ["", ""],
    [42, ""],
    [undefined, ""],
  ])("normalizeContentType(%j) → %j", (input, expected) => {
    expect(normalizeContentType(input)).toBe(expected);
  });

  it.each([
    ["application/pdf", true],
    ["IMAGE/PNG", true],
    ["image/jpeg", true],
    ["image/gif", true],
    ["image/webp", true],
    ["text/plain; charset=utf-8", true],
    ["text/csv", true],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", true],
    ["image/svg+xml", false],
    ["text/html", false],
    ["application/javascript", false],
    ["application/x-msdownload", false],
    ["application/octet-stream", false],
    ["", false],
    [null, false],
  ])("isAllowedContentType(%j) === %s with the approved defaults", (type, allowed) => {
    expect(isAllowedContentType(type, DEFAULT_UPLOAD_ALLOWED_TYPES)).toBe(allowed);
  });
});

describe("uploadProblem (size and type, P8: 10 MB)", () => {
  it("accepts exactly the maximum size, rejects one byte more", () => {
    expect(uploadProblem({ size: DEFAULT_UPLOAD_MAX_BYTES, contentType: "application/pdf" }, LIMITS)).toBeNull();
    expect(uploadProblem({ size: DEFAULT_UPLOAD_MAX_BYTES + 1, contentType: "application/pdf" }, LIMITS)).toBe(
      fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES),
    );
    expect(fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES)).toBe("This file is too large. The maximum size is 10 MB.");
  });

  it("rejects a disallowed type", () => {
    expect(uploadProblem({ size: 10, contentType: "text/html" }, LIMITS)).toBe(FILE_TYPE_NOT_ALLOWED_MESSAGE);
  });

  it.each([[-1], [1.5], [Number.NaN], ["10"], [undefined]])("rejects the invalid size %j", (size) => {
    expect(uploadProblem({ size, contentType: "application/pdf" }, LIMITS)).toBe("Invalid file size.");
  });

  it("accepts an empty file of an allowed type", () => {
    expect(uploadProblem({ size: 0, contentType: "text/plain" }, LIMITS)).toBeNull();
  });
});

describe("display names", () => {
  it.each([
    ["  report.pdf  ", "report.pdf"],
    ["invoice‮fdp.exe", "invoicefdp.exe"],
    ["a\u0000b\u0007c.txt", "abc.txt"],
    ["two\r\nlines.txt", "two lines.txt"],
    ["many    spaces\tand tabs.txt", "many spaces and tabs.txt"],
    ["Presupuesto año 2026.xlsx", "Presupuesto año 2026.xlsx"],
    [42, ""],
    ["‮", ""],
  ])("sanitizeDisplayName(%j) → %j", (input, expected) => {
    expect(sanitizeDisplayName(input)).toBe(expected);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [DEFAULT_UPLOAD_MAX_BYTES, "10 MB"],
  ])("%i → %j", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
