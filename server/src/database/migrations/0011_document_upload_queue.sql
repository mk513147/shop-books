-- 0011_document_upload_queue
--
-- Bill documents uploaded while the document storage (the storage agent on the owner's desktop)
-- is unreachable. The bytes are written here in the SAME transaction as their expense_documents
-- row, so an accepted upload is never lost. A background job hands them to the storage when it is
-- back and then deletes the queue row (the document row itself is never deleted). Until then the
-- API serves the document from here. Nothing else changes: existing documents are untouched.

CREATE TABLE document_upload_queue (
  document_id      uuid        PRIMARY KEY REFERENCES expense_documents (id) ON DELETE RESTRICT,
  content          bytea       NOT NULL,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  attempts         integer     NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  last_error       text,

  CONSTRAINT document_upload_queue_size_valid CHECK (octet_length(content) BETWEEN 1 AND 10485760),
  CONSTRAINT document_upload_queue_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT document_upload_queue_error_valid CHECK (last_error IS NULL OR length(last_error) <= 500)
);

CREATE INDEX document_upload_queue_queued_idx ON document_upload_queue (queued_at);

-- The queued bytes must be exactly the document that was recorded (size and SHA-256), and they can
-- never be changed while waiting (only the delivery bookkeeping columns may be updated).
CREATE FUNCTION check_document_upload_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc expense_documents%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.document_id <> OLD.document_id) THEN
    RAISE EXCEPTION 'queued document content cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO doc FROM expense_documents WHERE id = NEW.document_id;
  IF octet_length(NEW.content) <> doc.size_bytes OR sha256(NEW.content) <> doc.sha256 THEN
    RAISE EXCEPTION 'queued document content does not match its recorded size and SHA-256'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_upload_queue_check
  BEFORE INSERT OR UPDATE ON document_upload_queue
  FOR EACH ROW EXECUTE FUNCTION check_document_upload_queue();
