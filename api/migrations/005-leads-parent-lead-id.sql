-- 005-leads-parent-lead-id.sql
-- Adds the parent_lead_id column that api/server.js's distributeLead()
-- already writes to when a lead is distributed to a 2nd/3rd contractor
-- (see the secondary-company loop). That column has never existed on the
-- live public.leads table, which made every such insert fail — silently,
-- because its result was never checked (fixed separately in server.js
-- alongside this migration).
--
-- Idempotent: safe to run multiple times. Does not modify any existing
-- row data — this only adds a nullable column, an index, and a
-- self-referencing foreign key.
--
-- NOT applied by this change. Local file only, for review before a
-- separate, explicit apply step against the real database.

-- Sanity check: every other primary key in this schema (companies.id,
-- purchases.company_id, payment_reservations.company_id, etc. — see
-- api/migrations/003-payment-reservation-architecture.sql) is BIGINT.
-- This migration assumes public.leads.id follows the same convention.
-- Fail loudly rather than silently create a mismatched/broken column if
-- that assumption turns out to be wrong on the real database.
DO $$
DECLARE
  leads_id_type text;
BEGIN
  SELECT data_type INTO leads_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'id';

  IF leads_id_type IS NULL THEN
    RAISE EXCEPTION 'public.leads.id not found — cannot verify type before adding parent_lead_id';
  END IF;

  IF leads_id_type NOT IN ('bigint', 'integer', 'smallint') THEN
    RAISE EXCEPTION 'public.leads.id is % (expected bigint/integer) — update this migration to match before applying', leads_id_type;
  END IF;
END $$;

-- Nullable: only rows created for a 2nd/3rd contractor ever populate this;
-- a lead's own primary/original row has no parent.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS parent_lead_id BIGINT;

-- ON DELETE SET NULL, not CASCADE: parent_lead_id is provenance metadata
-- only (nothing in the app currently reads it — see the Blocker 2
-- investigation). If the original/primary lead row is ever deleted, the
-- other contractors' own lead records are independent business records
-- (their own status, their own credit already spent) and must not
-- disappear along with it. RESTRICT would instead block deleting the
-- original lead entirely while copies exist, which is more disruptive
-- than this design needs for a field nothing depends on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leads_parent_lead_id_fkey'
      AND conrelid = 'public.leads'::regclass
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_parent_lead_id_fkey
      FOREIGN KEY (parent_lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Partial index: most rows are primary leads with a NULL parent_lead_id,
-- so only index the rows a future "find this lead's other copies" query
-- would actually filter on.
CREATE INDEX IF NOT EXISTS idx_leads_parent_lead_id
  ON public.leads(parent_lead_id)
  WHERE parent_lead_id IS NOT NULL;
