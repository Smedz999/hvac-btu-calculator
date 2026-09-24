-- 007-harden-transition-trigger-search-path.sql
-- Local-only hardening fix, NOT applied to any database by this repo.
--
-- prevent_invalid_transitions() (defined in 003-payment-reservation-architecture.sql)
-- is a trigger function on payment_reservations that was missing the same
-- SECURITY DEFINER + SET search_path = public, pg_temp hardening every other
-- function in migration 003 already has (see that file's own "This ensures:"
-- comment block: owner-privilege execution, no search_path injection,
-- schema-qualified references regardless of caller).
--
-- Practical risk from the omission was low: the function only compares
-- OLD.status/NEW.status (plain TEXT columns already resolved via the
-- trigger's row context, not looked up through search_path) and calls no
-- other unqualified function or table — there was nothing in its body a
-- search_path hijack could actually redirect. This migration closes the
-- inconsistency anyway, for defense-in-depth and so a future edit to this
-- function's body doesn't inherit an unpinned search_path by accident.
--
-- Idempotent: CREATE OR REPLACE FUNCTION with an identical signature
-- (no arguments, RETURNS TRIGGER) — safe to run multiple times, and safe to
-- run against a database that already has migration 003 applied. Does not
-- touch the trigger definition itself (DROP/CREATE TRIGGER in 003), which is
-- unaffected by replacing the function body it points to.

CREATE OR REPLACE FUNCTION prevent_invalid_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow same-state updates (no-op transitions)
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Prevent any transition FROM succeeded
  IF OLD.status = 'succeeded' AND NEW.status != 'succeeded' THEN
    RAISE EXCEPTION 'Invalid transition: succeeded -> %', NEW.status;
  END IF;

  -- Prevent any transition FROM cancelled
  IF OLD.status = 'cancelled' AND NEW.status != 'cancelled' THEN
    RAISE EXCEPTION 'Invalid transition: cancelled -> %', NEW.status;
  END IF;

  -- Prevent any transition FROM expired
  IF OLD.status = 'expired' AND NEW.status != 'expired' THEN
    RAISE EXCEPTION 'Invalid transition: expired -> %', NEW.status;
  END IF;

  -- Allow only specific transitions
  IF OLD.status = 'pending' AND NEW.status NOT IN ('processing', 'expired') THEN
    RAISE EXCEPTION 'Invalid transition: pending -> %', NEW.status;
  END IF;

  IF OLD.status = 'processing' AND NEW.status NOT IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid transition: processing -> %', NEW.status;
  END IF;

  RETURN NEW;
END;
$$;
