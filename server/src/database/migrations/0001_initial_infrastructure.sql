-- 0001_initial_infrastructure
--
-- Stage 1 infrastructure only. No financial tables are created here.
-- (The schema_migrations history table is created by the migration runner itself.)

-- Case-insensitive text, used for user e-mail addresses in Stage 2.
CREATE EXTENSION IF NOT EXISTS citext;

-- Shared trigger function: keeps an "updated_at" column current on UPDATE.
-- Later migrations attach it to tables with:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
