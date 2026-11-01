/** Mirrors server/src/modules/documents/documents.validation.ts. The server re-checks everything. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_EXPENSE = 10;

const ALLOWED: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** For <input accept>: MIME types and extensions (some Android pickers only honour one of them). */
export const DOCUMENT_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';

/** Quick client-side check (name/size/type); returns an error message or null. */
export function checkFile(file: File): string | null {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const expected = ALLOWED[ext];
  if (!expected) return `${file.name}: only JPEG, PNG, WebP photos and PDF files can be attached.`;
  if (file.type && file.type !== expected && !(file.type === 'image/jpg' && expected === 'image/jpeg')) {
    return `${file.name}: the file type does not match its name.`;
  }
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if (file.size > MAX_DOCUMENT_BYTES) return `${file.name}: larger than 10 MB (${formatBytes(file.size)}).`;
  return null;
}

/** 1536 -> "1.5 KB", 2_400_000 -> "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageName(name: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(name);
}
