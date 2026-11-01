-- 0009_monthly_reports
--
-- Stage 5: monthly e-mail reports: settings, recipients, jobs (one per reporting month),
-- deliveries (one per job + recipient) and an append-only attempt log.
--
-- Idempotency comes from the database, not from memory:
--   * report_jobs.period_start is UNIQUE        -> a month is generated at most once;
--   * report_deliveries (job_id, recipient_email) UNIQUE -> one delivery per recipient per month;
--   * deliveries move through a state machine and are claimed with FOR UPDATE SKIP LOCKED;
--   * the scheduler holds a PostgreSQL advisory lock while it works (one instance at a time).
-- No existing table or row is changed except the audit entity/action lists.

-- Singleton settings row (id is always true).
CREATE TABLE report_settings (
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  enabled          boolean     NOT NULL DEFAULT false,
  -- Day of the month (1–28, so it exists in every month) and Asia/Kolkata time of delivery for
  -- the PREVIOUS month's report.
  delivery_day     smallint    NOT NULL DEFAULT 1 CHECK (delivery_day BETWEEN 1 AND 28),
  delivery_time    time        NOT NULL DEFAULT '08:00' CHECK (delivery_time = date_trunc('minute', delivery_time)),
  include_excel    boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- NULL only for the default row created by this migration.
  updated_by       uuid        REFERENCES users (id) ON DELETE RESTRICT
);
INSERT INTO report_settings (id) VALUES (true);

CREATE TRIGGER report_settings_set_updated_at
  BEFORE UPDATE ON report_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE report_recipients (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       citext      NOT NULL,
  name        text,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by  uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT report_recipients_email_valid CHECK (email = btrim(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT report_recipients_name_valid CHECK (name IS NULL OR (name = btrim(name) AND length(name) BETWEEN 1 AND 100))
);

-- No duplicate ACTIVE recipients (case-insensitive: citext).
CREATE UNIQUE INDEX report_recipients_active_email_unique ON report_recipients (email) WHERE is_active;

CREATE TRIGGER report_recipients_set_updated_at
  BEFORE UPDATE ON report_recipients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Removing a recipient = deactivating (history of deliveries keeps the address).
CREATE TRIGGER report_recipients_no_delete
  BEFORE DELETE ON report_recipients
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();


CREATE TABLE report_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The reporting month: first and last calendar day (Asia/Kolkata business dates).
  period_start   date        NOT NULL,
  period_end     date        NOT NULL,
  -- When it was due (schedule) or requested (manual).
  scheduled_for  timestamptz NOT NULL,
  trigger        text        NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  include_excel  boolean     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- NULL when created by the scheduler.
  created_by     uuid        REFERENCES users (id) ON DELETE RESTRICT,

  CONSTRAINT report_jobs_period_unique UNIQUE (period_start),
  CONSTRAINT report_jobs_period_month CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date),
  CONSTRAINT report_jobs_trigger_actor CHECK ((trigger = 'manual') = (created_by IS NOT NULL))
);


-- State machine:
--   pending --claim--> processing --> sent            (accepted by the e-mail provider)
--                                 --> simulated       (written to the local outbox; NOT sent)
--                                 --> retry_scheduled (temporary failure; next_attempt_at set)
--                                 --> failed          (permanent failure, retries exhausted, or
--                                                      interrupted with an unknown outcome)
--   retry_scheduled --claim--> processing ...
--   failed --manual retry (owner)--> retry_scheduled
CREATE TABLE report_deliveries (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid        NOT NULL REFERENCES report_jobs (id) ON DELETE RESTRICT,
  recipient_id         uuid        REFERENCES report_recipients (id) ON DELETE RESTRICT,
  recipient_email      citext      NOT NULL,
  status               text        NOT NULL DEFAULT 'pending',
  attempt_count        integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  locked_at            timestamptz,
  last_attempt_at      timestamptz,
  sent_at              timestamptz,
  provider             text,
  provider_message_id  text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 300),
  last_error           text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_deliveries_unique_recipient UNIQUE (job_id, recipient_email),
  CONSTRAINT report_deliveries_status_valid CHECK (
    status IN ('pending', 'processing', 'sent', 'simulated', 'retry_scheduled', 'failed')),
  CONSTRAINT report_deliveries_processing_locked CHECK ((status = 'processing') = (locked_at IS NOT NULL)),
  CONSTRAINT report_deliveries_sent_consistent CHECK ((status IN ('sent', 'simulated')) = (sent_at IS NOT NULL))
);

CREATE INDEX report_deliveries_due_idx ON report_deliveries (next_attempt_at) WHERE status IN ('pending', 'retry_scheduled');
CREATE INDEX report_deliveries_job_idx ON report_deliveries (job_id);

CREATE TRIGGER report_deliveries_set_updated_at
  BEFORE UPDATE ON report_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A delivery that was sent (or simulated) is final: it can never be re-queued, so a successful
-- recipient is never e-mailed twice because another recipient failed.
CREATE FUNCTION guard_report_delivery_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('sent', 'simulated') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a delivered report cannot change state again' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.job_id <> OLD.job_id OR NEW.recipient_email <> OLD.recipient_email THEN
    RAISE EXCEPTION 'delivery job and recipient are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_deliveries_guard_update
  BEFORE UPDATE ON report_deliveries
  FOR EACH ROW EXECUTE FUNCTION guard_report_delivery_update();


-- Append-only log of every attempt (who/when/outcome/error); never contains message content.
CREATE TABLE report_delivery_attempts (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id          uuid        NOT NULL REFERENCES report_deliveries (id) ON DELETE RESTRICT,
  attempt_number       integer     NOT NULL CHECK (attempt_number >= 1),
  started_at           timestamptz NOT NULL,
  finished_at          timestamptz NOT NULL DEFAULT now(),
  outcome              text        NOT NULL CHECK (outcome IN ('sent', 'simulated', 'retryable_failure', 'failed', 'interrupted')),
  provider             text,
  provider_message_id  text,
  error                text CHECK (error IS NULL OR length(error) <= 1000),
  UNIQUE (delivery_id, attempt_number)
);

CREATE TRIGGER report_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON report_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();


-- Audit: changes to report settings / recipients and manual actions (run, retry).
ALTER TABLE financial_audit_events
  DROP CONSTRAINT financial_audit_entity_valid,
  DROP CONSTRAINT financial_audit_action_valid,
  ADD CONSTRAINT financial_audit_entity_valid CHECK (entity_type IN (
    'expense', 'expense_category', 'supplier', 'supplier_payment', 'customer', 'customer_transaction',
    'report_settings', 'report_recipient', 'report_job', 'report_delivery')),
  ADD CONSTRAINT financial_audit_action_valid CHECK (action IN (
    'create', 'update', 'void', 'restore', 'archive', 'reactivate', 'link_category', 'unlink_category', 'import',
    'document_add', 'document_remove', 'reverse', 'allocate', 'release_allocation', 'retry'));
