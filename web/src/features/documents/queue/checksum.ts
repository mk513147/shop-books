/** Reads a Blob's bytes (FileReader fallback for environments without Blob.arrayBuffer). */
export function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Lower-case hex SHA-256 of a Blob (Web Crypto; needs a secure context, i.e. HTTPS or localhost). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This browser cannot check files securely (open the app over HTTPS).');
  const digest = await subtle.digest('SHA-256', await readBlob(blob));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
