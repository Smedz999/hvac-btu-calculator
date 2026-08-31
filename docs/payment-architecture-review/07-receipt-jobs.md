# 07-receipt-jobs.md — Receipt Job Worker Flow

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 02-database-tables.md, 03-rls-permissions.md

---

## Overview

This document contains the receipt job worker flow, including RPC functions and crash recovery.

**Authoritative definitions:**
- Receipt job RPC functions
- Worker flow logic
- Crash recovery logic

---

## Receipt Outbox Table

**See:** 02-database-tables.md for `receipt_outbox` table schema

### Key Properties
- **UNIQUE reservation_id** — Prevents duplicate receipt jobs for the same payment
- **provider_message_id** — Stores idempotency key from email provider (e.g., Resend message ID)
- **Atomic creation** — Created in same transaction as payment processing
- **Independent from webhook** — Email failure cannot cause payment reprocessing

### Receipt Job States

| State | `last_attempt_at` | `sent_at` | `provider_message_id` | Description |
|-------|-------------------|-----------|----------------------|-------------|
| `pending` | NULL | NULL | NULL | Ready to be claimed |
| `processing` | NOT NULL | NULL | NULL | Claimed by worker, sending in progress |
| `sent` | NOT NULL | NOT NULL | NOT NULL | Successfully delivered |
| `failed` | NOT NULL | NULL | NULL | Max retries exceeded |

---

## Worker Flow

### 1. Claim Job (Concurrency-Safe)

```sql
CREATE OR REPLACE FUNCTION claim_receipt_job()
RETURNS TABLE (
  id UUID,
  reservation_id UUID,
  company_id UUID,
  credits_added INTEGER,
  amount_pence INTEGER,
  balance_after INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.receipt_outbox
  SET 
    status = 'processing',
    last_attempt_at = NOW(),
    attempts = attempts + 1
  WHERE id = (
    SELECT id FROM public.receipt_outbox
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING 
    receipt_outbox.id,
    receipt_outbox.reservation_id,
    receipt_outbox.company_id,
    receipt_outbox.credits_added,
    receipt_outbox.amount_pence,
    receipt_outbox.balance_after;
END;
$$;
```

**Concurrency Safety:**
- `FOR UPDATE SKIP LOCKED` ensures only one worker can claim a job
- Multiple workers can run concurrently without duplicate sends
- Atomic status transition from `pending` to `processing`

---

### 2. Send Email with Idempotency

```javascript
async function sendReceipt(job) {
  const company = await getCompany(job.company_id);
  
  // Use reservation_id as idempotency key for email provider
  // This prevents duplicate sends if worker retries after network failure
  const idempotencyKey = `receipt_${job.reservation_id}`;
  
  try {
    const result = await resend.emails.send({
      from: 'receipts@acconnx.com',
      to: company.email,
      subject: 'Payment Receipt - ACConnx Credits',
      html: renderReceiptEmail(job),
    }, {
      idempotencyKey: idempotencyKey
    });
    
    return { success: true, provider_message_id: result.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

---

### 3. Mark Job Complete

```sql
CREATE OR REPLACE FUNCTION complete_receipt_job(
  p_job_id UUID,
  p_provider_message_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.receipt_outbox
  SET 
    status = 'sent',
    sent_at = NOW(),
    provider_message_id = p_provider_message_id
  WHERE id = p_job_id AND status = 'processing';
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found or not in processing state: %', p_job_id;
  END IF;
END;
$$;
```

---

### 4. Mark Job Failed (Retry Logic)

```sql
CREATE OR REPLACE FUNCTION fail_receipt_job(
  p_job_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts INTEGER;
BEGIN
  -- Atomic conditional update: only fail if still in processing state
  UPDATE public.receipt_outbox
  SET 
    status = CASE 
      WHEN attempts >= 5 THEN 'failed'
      ELSE 'pending'
    END,
    attempts = attempts + 1
  WHERE id = p_job_id 
    AND status = 'processing'  -- Only update if still processing
  RETURNING attempts INTO v_attempts;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found or not in processing state: %', p_job_id;
  END IF;
END;
$$;
```

---

### 5. Update Reservation Audit State

```javascript
async function updateReservationReceiptSent(reservation_id) {
  // This is audit state only, not the concurrency mechanism
  // The receipt_outbox table is the source of truth for receipt delivery
  await supabase
    .from('payment_reservations')
    .update({ receipt_sent_at: new Date().toISOString() })
    .eq('id', reservation_id);
}
```

---

## Complete Worker Loop

```javascript
async function receiptWorker() {
  while (true) {
    // Claim next job (concurrency-safe)
    // Use .maybeSingle() since claim_receipt_job can return 0 or 1 row
    const { data: job, error } = await supabase.rpc('claim_receipt_job').maybeSingle();
    
    if (error) {
      console.error('Error claiming receipt job:', error);
      await sleep(5000);
      continue;
    }
    
    if (!job) {
      // No jobs available, wait before next poll
      await sleep(5000);
      continue;
    }
    
    // Send email with idempotency key
    const result = await sendReceipt(job);
    
    if (result.success) {
      // Mark job complete
      await supabase.rpc('complete_receipt_job', {
        p_job_id: job.id,
        p_provider_message_id: result.provider_message_id
      });
      
      // Update reservation audit state (non-critical)
      await updateReservationReceiptSent(job.reservation_id);
    } else {
      // Mark job failed (will retry or mark as failed after max attempts)
      await supabase.rpc('fail_receipt_job', {
        p_job_id: job.id
      });
    }
  }
}
```

---

## Crash Recovery

**Scenario:** Email sent successfully, but worker crashes before marking job complete.

**Recovery:**
1. Job remains in `processing` state
2. Cleanup job finds stale `processing` jobs (e.g., `last_attempt_at` > 5 minutes ago)
3. Checks with email provider using `provider_message_id` or idempotency key
4. If provider confirms delivery: mark as `sent`
5. If provider has no record: reset to `pending` for retry

```javascript
async function recoverStaleReceiptJobs() {
  const { data: staleJobs } = await supabase
    .from('receipt_outbox')
    .select('*')
    .eq('status', 'processing')
    .lt('last_attempt_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
  
  for (const job of staleJobs) {
    // Check with email provider
    const idempotencyKey = `receipt_${job.reservation_id}`;
    const providerStatus = await checkEmailProviderStatus(idempotencyKey);
    
    if (providerStatus.delivered) {
      await supabase.rpc('complete_receipt_job', {
        p_job_id: job.id,
        p_provider_message_id: providerStatus.message_id
      });
    } else {
      // Reset to pending for retry
      await supabase
        .from('receipt_outbox')
        .update({ status: 'pending' })
        .eq('id', job.id);
    }
  }
}
```

---

## Duplicate Prevention

| Mechanism | Purpose |
|-----------|---------|
| `UNIQUE reservation_id` | Prevents duplicate receipt jobs for same payment |
| `FOR UPDATE SKIP LOCKED` | Prevents concurrent workers from claiming same job |
| Idempotency key | Prevents duplicate sends to email provider |
| `provider_message_id` | Allows verification of delivery status |

---

## Independence from Webhook

- Receipt jobs are created in same transaction as payment processing
- Webhook returns success immediately after payment processing
- Email delivery happens asynchronously in separate worker
- Email failure does NOT cause Stripe webhook retry
- Email failure does NOT cause payment reprocessing

---

## Summary

This document contains the receipt job worker flow. All receipt jobs are created atomically with payment processing and processed independently by workers. Crash recovery ensures no receipt is lost.

**Next:** See 08-tests-invariants.md for test examples.
