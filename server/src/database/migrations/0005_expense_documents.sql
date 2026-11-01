-- 0005_expense_documents
--
-- Stage 3B: bill photographs / PDF documents attached to expenses.
--
-- Only METADATA lives in PostgreSQL; file contents live in private document storage (see
-- server/src/modules/documents/storage.ts) under a random, server-generated storage key. Original
-- filenames are display metadata only and never used as paths.
--
-- Write order (application): the file is stored FIRST, then this row (+ audit event) is inserted in
-- one transaction. A row therefore only ever exists for a file that was stored successfully. If the
-- transaction fails, the application deletes the file; anything left behind (crash, failed delete)
-- is an orphan FILE without a row, found by `npm run documents:reconcile`.
--
-- Removal is a status change (never a DELETE): the row and the stored file are kept as evidence.
-- No existing data is modified by this migration.

CREATE TABLE expense_documents (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id         uuid        NOT NULL REFERENCES expenses (id) ON DELETE RESTRICT,
  original_filename  text        NOT NULL,
  storage_key        text        NOT NULL,
  -- Detected from the file's signature (magic bytes), never taken from the browser.
  mime_type          text        NOT NULL,
  size_bytes         integer     NOT NULL,
  -- SHA-256 of the stored bytes: integrity check and duplicate detection.
  sha256             bytea       NOT NULL,
  status             text        NOT NULL DEFAULT 'active',
  uploaded_by        uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  removed_by         uuid        REFERENCES users (id) ON DELETE RESTRICT,
  remove_reason      text,

  CONSTRAINT expense_documents_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT expense_documents_storage_key_valid CHECK (storage_key ~ '^[a-z0-9]+(/[a-z0-9]+)*$' AND length(storage_key) <= 200),
  CONSTRAINT expense_documents_filename_valid CHECK (
    original_filename = btrim(original_filename) AND length(original_filename) BETWEEN 1 AND 255
    AND original_filename !~ '[[:cntrl:]/\\]'),
  CONSTRAINT expense_documents_mime_valid CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  -- 10 MB maximum per file.
  CONSTRAINT expense_documents_size_valid CHECK (size_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT expense_documents_sha256_valid CHECK (octet_length(sha256) = 32),
  CONSTRAINT expense_documents_status_valid CHECK (status IN ('active', 'removed')),
  CONSTRAINT expense_documents_removal_consistent CHECK (
    (status = 'active' AND removed_at IS NULL AND removed_by IS NULL AND remove_reason IS NULL) OR
    (status = 'removed' AND removed_at IS NOT NULL AND removed_by IS NOT NULL AND remove_reason IS NOT NULL
       AND remove_reason = btrim(remove_reason) AND length(remove_reason) BETWEEN 1 AND 500))
);

CREATE INDEX expense_documents_expense_idx ON expense_documents (expense_id, created_at);
-- The same file cannot be attached twice to one expense (retries and double taps return the
-- existing document instead).
CREATE UNIQUE INDEX expense_documents_active_sha_unique
  ON expense_documents (expense_id, sha256) WHERE status = 'active';

-- Document metadata is never deleted (remove = status change), like every financial record.
CREATE FUNCTION prevent_expense_document_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'expense documents are never deleted; remove them instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER expense_documents_no_delete
  BEFORE DELETE ON expense_documents
  FOR EACH ROW EXECUTE FUNCTION prevent_expense_document_delete();

-- At most 10 ACTIVE documents per expense. The application checks this under a lock on the
-- expense row; this trigger is the database-level backstop.
CREATE FUNCTION enforce_expense_document_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND
     (SELECT count(*) FROM expense_documents WHERE expense_id = NEW.expense_id AND status = 'active') > 10 THEN
    RAISE EXCEPTION 'an expense can have at most 10 documents'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER expense_documents_limit
  AFTER INSERT OR UPDATE OF status ON expense_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_expense_document_limit();


-- Financial audit: document events are recorded on the EXPENSE (so they appear in its history).
-- Removal requires a reason, like void/restore.
ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_action_valid,
  DROP CONSTRAINT financial_audit_reason_valid,
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import',
    'document_add', 'document_remove')),
  ADD CONSTRAINT financial_audit_reason_valid CHECK (
    (action IN ('void', 'restore', 'document_remove') AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500)
    OR (action NOT IN ('void', 'restore', 'document_remove') AND reason IS NULL));
