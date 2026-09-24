-- 009-lockdown-unreferenced-tables-VERIFY-FIRST.sql
-- Local-only proposed migration, NOT applied to any database by this repo.
--
-- DO NOT APPLY WITHOUT FIRST CONFIRMING NOTHING ELSE DEPENDS ON THESE
-- TABLES — this file is lower-confidence than 008 and is kept separate
-- from it deliberately so the two are never applied as a single
-- all-or-nothing unit.
--
-- Confirmed externally via a read-only Supabase security-advisor check
-- (2026-09-24): suppliers, products, orders, and order_items currently
-- have RLS DISABLED and are flagged as exposed public/PostgREST tables.
--
-- Confirmed internally via an exhaustive repo search: none of these four
-- table names appear ANYWHERE in this repository — not in api/server.js,
-- not in any other .js file, not in any .html file, not in any migration
-- (no CREATE TABLE for any of them exists here either). ACConnX, as this
-- repo defines it, does not know these tables exist.
--
-- That means one of two things is true, and this review cannot tell you
-- which from the code alone:
--   (a) these are genuinely orphaned tables — leftovers from an earlier
--       prototype, a Supabase quickstart/template schema, or an abandoned
--       feature — and locking them down (or eventually dropping them) is
--       simply correct, or
--   (b) something outside this repository (a different application
--       sharing this Supabase project, an internal tool, an automation)
--       uses them, in which case REVOKE-ing anon/authenticated access
--       here could break that other thing.
--
-- Given that ambiguity, this migration is intentionally NOT bundled with
-- migration 008. Before applying it: check the Supabase dashboard's table
-- editor for row counts and recent activity on these four tables (empty +
-- no recent writes strongly supports (a)), and ask whoever has
-- organizational context on this Supabase project whether anything else
-- reads from or writes to them. If in doubt, enabling RLS with no
-- policies (as below) is the reversible, safe-by-default choice over
-- dropping the tables outright — it can be undone by adding a policy
-- later, whereas dropping data cannot be undone.
--
-- This migration does NOT grant service_role anything on these tables
-- either, for the same reason: no evidence exists that ACConnX's backend
-- needs to touch them, so nothing here should be un-done later if these
-- turn out to be safe to leave alone rather than delete.
--
-- Idempotent: safe to run multiple times, touches no data or structure.

ALTER TABLE IF EXISTS public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.order_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.suppliers FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.products FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.orders FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.order_items FROM anon, authenticated, PUBLIC;
