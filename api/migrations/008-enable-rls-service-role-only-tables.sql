-- 008-enable-rls-service-role-only-tables.sql
-- Local-only proposed migration, NOT applied to any database by this repo.
--
-- Confirmed externally via a read-only Supabase security-advisor check
-- (2026-09-24): leads, prospects, and tasks currently have RLS DISABLED and
-- are flagged as exposed public/PostgREST tables.
--
-- Confirmed internally via an exhaustive repo search before writing this
-- migration:
--   - Every Supabase client constructed anywhere in this codebase
--     (api/server.js, scripts/migrate-coverage-areas.js, and the test
--     files that construct their own client) uses SUPABASE_SERVICE_KEY.
--     There is no anon-key or authenticated-session client anywhere.
--   - grep across every .html file in the repo for "supabase" returns zero
--     matches — there is no browser/client-side Supabase access at all.
--   - All 11 references to .from('leads'), all 4 to .from('prospects'),
--     and all 4 to .from('tasks') in api/server.js go through the single
--     module-level `supabase` client, which is that service-role client.
--
-- In other words: leads (customer_name/email/phone/postcode — homeowner
-- PII), prospects, and tasks are, in this application, reachable ONLY
-- through server.js's service-role client. Nothing here depends on
-- anon/authenticated access to them, so this mirrors EXACTLY the pattern
-- migration 003 already established (and which is already running
-- correctly in production today) for companies/purchases/credit_ledger/
-- payment_reservations/receipt_outbox/credit_packages: enable RLS, add no
-- policies, and let service_role's BYPASSRLS attribute continue to grant
-- the backend everything it already has. Enabling RLS this way changes
-- nothing about what the application can do — it only closes off the
-- direct-PostgREST-request path that RLS-disabled currently leaves open to
-- anyone holding this project's anon key.
--
-- CAVEAT (stated plainly, not glossed over): this conclusion is scoped to
-- what exists IN THIS REPOSITORY. If some other consumer outside this
-- codebase — a separate app, an internal dashboard tool, a Zapier/Make
-- automation, a BI tool — queries these three tables directly via the
-- Supabase anon or authenticated key, enabling RLS here with no policies
-- would break that consumer's access. Nothing found during this review
-- suggests such a consumer exists, but this review has no visibility
-- outside this repo's own code, so this should be confirmed by whoever
-- owns the Supabase project before applying.
--
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is safe to run
-- multiple times (it's a no-op if already enabled). REVOKE ALL is a no-op
-- if the privilege isn't currently granted. No table structure, data, or
-- existing policy is touched.

ALTER TABLE IF EXISTS public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tasks ENABLE ROW LEVEL SECURITY;

-- Defense-in-depth, matching migration 003's explicit-REVOKE convention:
-- even without this, RLS-enabled-with-no-policies already denies anon/
-- authenticated by default. Explicit REVOKE means that stays true even if
-- a future migration accidentally grants table-level privileges to these
-- roles without adding a matching policy.
REVOKE ALL ON public.leads FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.prospects FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.tasks FROM anon, authenticated, PUBLIC;

-- No policies added, deliberately. service_role bypasses RLS (Supabase's
-- built-in BYPASSRLS attribute on that role) and already holds whatever
-- base table privileges let the application work today — this migration
-- doesn't grant it anything new, only closes the anon/authenticated gap.
