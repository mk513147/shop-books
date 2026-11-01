import { AppError } from '../../utils/errors.js';

/** Upload limits (mirrored in web/src/features/documents/limits.ts). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_EXPENSE = 10;

export const DOCUMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

const EXTENSIONS: Record<string, DocumentMimeType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

/**
 * Identifies the file from its CONTENT (signature + basic structure), ignoring the name and the
 * browser-supplied type. Returns null for anything unsupported or obviously malformed.
 */
export function detectDocumentType(buf: Buffer): DocumentMimeType | null {
  // JPEG: SOI marker followed by another marker; must end with EOI (allowing trailing padding).
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    const tail = buf.subarray(Math.max(0, buf.length - 1024));
    return tail.includes(Buffer.from([0xff, 0xd9])) ? 'image/jpeg' : null;
  }
  // PNG: 8-byte signature, then the IHDR chunk (length 13).
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return buf.length >= 33 && buf.readUInt32BE(8) === 13 && ascii(buf, 12, 16) === 'IHDR' ? 'image/png' : null;
  }
  // WebP: RIFF container whose declared size fits the data, form type WEBP, VP8/VP8L/VP8X chunk.
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') {
    const declared = buf.length >= 12 ? buf.readUInt32LE(4) + 8 : 0;
    const chunk = ascii(buf, 12, 16);
    return declared <= buf.length && declared >= 20 && ['VP8 ', 'VP8L', 'VP8X'].includes(chunk) ? 'image/webp' : null;
  }
  // PDF: header at the start and an end-of-file marker near the end.
  if (ascii(buf, 0, 5) === '%PDF-') {
    const tail = ascii(buf, Math.max(0, buf.length - 2048), buf.length);
    return tail.includes('%%EOF') ? 'application/pdf' : null;
  }
  return null;
}

/**
 * Display name only (never a path): decoded, reduced to its last path segment, control characters
 * and slashes removed, whitespace collapsed, at most 255 characters (keeping the extension).
 */
export function sanitiseFileName(raw: string | undefined): string {
  let name = raw ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded: use as is.
  }
  name = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
    name = name.slice(0, 255 - ext.length).trimEnd() + ext;
  }
  return name;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

const reject = (code: string, message: string) => new AppError(400, code, message);

export interface ValidatedUpload {
  fileName: string;
  mimeType: DocumentMimeType;
  sizeBytes: number;
}

/**
 * Validates an uploaded file: size, a usable name with an allowed extension, the real content type
 * (magic bytes), and that extension, content and (if sent) the browser's declared type all agree.
 */
export function validateUpload(body: unknown, rawFileName: string | undefined, declaredType: string | undefined): ValidatedUpload {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw reject('DOCUMENT_EMPTY', 'Choose a file to upload (send it as application/octet-stream).');
  }
  if (body.length > MAX_DOCUMENT_BYTES) {
    throw new AppError(413, 'DOCUMENT_TOO_LARGE', 'Files can be at most 10 MB.');
  }
  const fileName = sanitiseFileName(rawFileName);
  if (!fileName) throw reject('DOCUMENT_NAME_REQUIRED', 'The file name is missing.');
  const extension = extensionOf(fileName);
  const byExtension = extension ? EXTENSIONS[extension] : undefined;
  if (!byExtension) {
    throw reject('DOCUMENT_TYPE_NOT_ALLOWED', 'Only JPEG, PNG, WebP photos and PDF documents can be attached.');
  }
  const detected = detectDocumentType(body);
  if (!detected) {
    throw reject('DOCUMENT_INVALID', 'This file is damaged or is not a real JPEG, PNG, WebP or PDF file.');
  }
  if (detected !== byExtension) {
    throw reject('DOCUMENT_TYPE_MISMATCH', 'The file extension does not match its contents.');
  }
  if (declaredType) {
    const declared = declaredType.split(';')[0]!.trim().toLowerCase().replace('image/jpg', 'image/jpeg');
    if (declared && declared !== detected) {
      throw reject('DOCUMENT_TYPE_MISMATCH', 'The file type does not match its contents.');
    }
  }
  return { fileName, mimeType: detected, sizeBytes: body.length };
}
