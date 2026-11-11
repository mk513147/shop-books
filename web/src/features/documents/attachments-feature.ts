/**
 * Bill photo/PDF attachments are POSTPONED (business decision; see docs/bill-attachments-postponed.md).
 *
 * Off unless the build sets VITE_BILL_ATTACHMENTS=enabled. While off, the app offers no way to
 * attach files, runs no offline attachment queue, and shows documents that are already on record
 * read-only. Turn it on only together with the API's DOCUMENT_STORAGE_DRIVER (agent/local) and a
 * permanent storage location; the queue, drafts and storage-agent code are kept for that day.
 *
 * A function (not a constant) so tests can switch it with vi.stubEnv.
 */
export function billAttachmentsEnabled(): boolean {
  return import.meta.env.VITE_BILL_ATTACHMENTS === 'enabled';
}
