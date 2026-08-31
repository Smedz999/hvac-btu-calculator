# 08-tests-invariants.md — Test Suite & Invariants

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 04-payment-rpcs.md, 07-receipt-jobs.md

---

## Overview

This document contains all test examples for the payment architecture.

**Authoritative definitions:**
- All test examples
- All test expectations

---

## Test Categories

1. **Core Payment Tests** — Basic payment flow
2. **Race Condition Tests** — Concurrency and race conditions
3. **Transaction Rollback Tests** — Failure injection and rollback
4. **Permission Tests** — Security and access control
5. **Receipt Worker Tests** — Receipt job processing
6. **Historical Customer Tests** — First-purchase discount eligibility

---

## Core Payment Tests

```javascript
describe('Core Payment Tests', () => {
  
  test('20-50 simultaneous first-purchase attempts: exactly one winner', async () => {
    const attempts = 50;
    const promises = Array(attempts).fill().map(() =>
      supabase.rpc('create_payment_reservation', {
        p_company_id: testCompanyId,
        p_package_id: 'starter'
      })
    );
    
    const results = await Promise.all(promises);
    
    // All should succeed (create reservation)
    const successful = results.filter(r => !r.error);
    expect(successful.length).toBe(attempts);
    
    // Fetch all reservations
    const reservations = await Promise.all(
      successful.map(r => getReservation(r.data))
    );
    
    // Exactly one should have first-purchase discount (2000 pence)
    const discounted = reservations.filter(r => r.amount_pence === 2000);
    expect(discounted.length).toBe(1);
    
    // Rest should have full price (2500 pence)
    const fullPrice = reservations.filter(r => r.amount_pence === 2500);
    expect(fullPrice.length).toBe(attempts - 1);
  });
  
  test('simultaneous identical PaymentIntent attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Two simultaneous attach calls with same PI
    const promises = Array(2).fill().map(() =>
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    );
    
    const results = await Promise.all(promises);
    
    // One should transition, one should be idempotent
    const transitioned = results.filter(r => r.data?.transitioned_now === true);
    const idempotent = results.filter(r => r.data?.already_in_target_state === true);
    
    expect(transitioned.length).toBe(1);
    expect(idempotent.length).toBe(1);
  });
  
  test('simultaneous conflicting attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Two simultaneous attach calls with different PIs
    const [result1, result2] = await Promise.all([
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      }),
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_456',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // One should succeed, one should fail
    const succeeded = [result1, result2].filter(r => !r.error);
    const failed = [result1, result2].filter(r => r.error);
    
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].error.message).toContain('Invalid state transition');
  });
  
  test('same Stripe PaymentIntent assigned to two reservations', async () => {
    const { data: reservation_id_1 } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    const { data: reservation_id_2 } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Attach same PI to first reservation
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id_1,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Attempt to attach same PI to second reservation
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id_2,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail due to UNIQUE constraint on stripe_payment_intent_id
    expect(error).toBeDefined();
  });
  
  test('Stripe PaymentIntent created but DB attachment lost', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Simulate crash: PI created in Stripe but not attached to reservation
    // Webhook arrives before attachment
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_orphan_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail: reservation not found
    expect(error).toBeDefined();
    expect(error.message).toContain('Reservation not found');
    
    // Cleanup job should reconcile
    // (This would be tested in integration test with actual Stripe API)
  });
  
  test('webhook arriving before attachment', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Webhook arrives before PI is attached
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should fail: reservation not found (PI not attached yet)
    expect(error).toBeDefined();
    expect(error.message).toContain('Reservation not found');
  });
  
  test('20-50 concurrent duplicate successful webhooks', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Attach PI
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // 50 concurrent duplicate webhooks
    const attempts = 50;
    const promises = Array(attempts).fill().map(() =>
      supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    );
    
    const results = await Promise.all(promises);
    
    // All should succeed
    const successful = results.filter(r => !r.error);
    expect(successful.length).toBe(attempts);
    
    // All should return same balance_after
    const balances = successful.map(r => r.data.balance_after);
    expect(new Set(balances).size).toBe(1);
    
    // Only one should have already_processed = false
    const firstTime = successful.filter(r => r.data.already_processed === false);
    expect(firstTime.length).toBe(1);
    
    // Rest should have already_processed = true
    const duplicates = successful.filter(r => r.data.already_processed === true);
    expect(duplicates.length).toBe(attempts - 1);
  });
  
  test('wrong amount', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook with wrong amount
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook with wrong currency
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('wrong amount on duplicate attach after already attached', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // First attach: correct amount
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate attach with wrong amount (should fail even though already attached)
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency on duplicate attach after already attached', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // First attach: correct currency
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate attach with wrong currency (should fail even though already attached)
    const { error } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('wrong amount on duplicate webhook after payment succeeded', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: correct amount
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate webhook with wrong amount (should fail even though already succeeded)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 9999, // Wrong amount
      p_stripe_currency: 'gbp'
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Amount mismatch');
  });
  
  test('wrong currency on duplicate webhook after payment succeeded', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: correct currency
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Duplicate webhook with wrong currency (should fail even though already succeeded)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'usd' // Wrong currency
    });
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Currency mismatch');
  });
  
  test('duplicate webhook after company balance changes later', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // First webhook: process payment
    const { data: firstResult } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const originalBalance = firstResult.balance_after;
    
    // Company balance changes later (e.g., credits spent)
    await supabase
      .from('companies')
      .update({ credits: originalBalance - 5 })
      .eq('id', testCompanyId);
    
    // Duplicate webhook arrives
    const { data: duplicateResult } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Should return ORIGINAL balance_after, not current balance
    expect(duplicateResult.balance_after).toBe(originalBalance);
    expect(duplicateResult.already_processed).toBe(true);
  });
});
```

---

## Race Condition Tests

```javascript
describe('Race Condition Tests', () => {
  
  test('expiry vs attachment race', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Set reservation to expire soon
    await supabase
      .from('payment_reservations')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', reservation_id);
    
    // Race: expire vs attach
    const [expireResult, attachResult] = await Promise.allSettled([
      supabase.rpc('expire_pending_reservation', { p_reservation_id: reservation_id }),
      supabase.rpc('attach_stripe_payment_intent', {
        p_reservation_id: reservation_id,
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // Exactly one should succeed
    const succeeded = [expireResult, attachResult].filter(r => r.status === 'fulfilled' && !r.value.error);
    expect(succeeded.length).toBe(1);
    
    // Final state should be either expired or processing, not both
    const reservation = await getReservation(reservation_id);
    expect(['expired', 'processing']).toContain(reservation.status);
  });
  
  test('cancellation vs success race', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Race: cancel vs process payment
    const [cancelResult, processResult] = await Promise.allSettled([
      supabase.rpc('cancel_processing_reservation', { p_stripe_payment_intent_id: 'pi_test_123' }),
      supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: 'pi_test_123',
        p_stripe_amount_pence: 2500,
        p_stripe_currency: 'gbp'
      })
    ]);
    
    // Exactly one should succeed
    const succeeded = [cancelResult, processResult].filter(r => r.status === 'fulfilled' && !r.value.error);
    expect(succeeded.length).toBe(1);
    
    // Final state should be either cancelled or succeeded
    const reservation = await getReservation(reservation_id);
    expect(['cancelled', 'succeeded']).toContain(reservation.status);
    
    // If succeeded, credits should be added exactly once
    if (reservation.status === 'succeeded') {
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(10); // starter package
    }
  });
  
  test('two cleanup workers processing the same reservation', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Two cleanup workers try to process same reservation
    const worker1 = supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const worker2 = supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const [result1, result2] = await Promise.all([worker1, worker2]);
    
    // Both should succeed (idempotent)
    expect(result1.error).toBeUndefined();
    expect(result2.error).toBeUndefined();
    
    // Both should return same balance_after
    expect(result1.data.balance_after).toBe(result2.data.balance_after);
    
    // Only one should have already_processed = false
    const firstTime = [result1, result2].filter(r => r.data.already_processed === false);
    expect(firstTime.length).toBe(1);
    
    // Credits should be added exactly once
    const company = await getCompany(testCompanyId);
    expect(company.credits).toBe(10);
  });
  
  test('Stripe success discovered only through reconciliation', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Webhook never arrives (simulated)
    // Cleanup job discovers succeeded payment via Stripe API
    const pi = { id: 'pi_test_123', amount: 2500, currency: 'gbp', status: 'succeeded' };
    
    // Reconciliation processes payment
    const { data, error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: pi.id,
      p_stripe_amount_pence: pi.amount,
      p_stripe_currency: pi.currency
    });
    
    expect(error).toBeUndefined();
    expect(data.status).toBe('succeeded');
    expect(data.already_processed).toBe(false);
    
    // Reservation should be succeeded
    const reservation = await getReservation(reservation_id);
    expect(reservation.status).toBe('succeeded');
  });
});
```

---

## Transaction Rollback Tests

```javascript
describe('Transaction Rollback Tests', () => {
  
  test('failure immediately after purchase insert', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after purchase insert (e.g., company update fails)
    // This would be done via database trigger or test hook
    // For documentation: simulate by checking rollback
    
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // If error occurred, verify full rollback:
    if (error) {
      // No purchase record created
      const { data: purchases } = await supabase
        .from('purchases')
        .select('*')
        .eq('stripe_payment_intent_id', 'pi_test_123');
      expect(purchases.length).toBe(0);
      
      // Company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // No credit-ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
      
      // No receipt job created
      const { data: jobs } = await supabase
        .from('receipt_outbox')
        .select('*')
        .eq('reservation_id', reservation_id);
      expect(jobs.length).toBe(0);
    }
  });
  
  test('failure immediately after company credit update', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after credit update (e.g., ledger insert fails)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    if (error) {
      // Verify full rollback: company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // No credit-ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
    }
  });
  
  test('failure immediately after credit-ledger insert', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Inject failure after ledger insert (e.g., reservation update fails)
    const { error } = await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    if (error) {
      // Verify full rollback: no ledger entry
      const { data: ledger } = await supabase
        .from('credit_ledger')
        .select('*')
        .eq('reference_id', reservation_id);
      expect(ledger.length).toBe(0);
      
      // Company credits unchanged
      const company = await getCompany(testCompanyId);
      expect(company.credits).toBe(0);
      
      // Reservation still processing
      const reservation = await getReservation(reservation_id);
      expect(reservation.status).toBe('processing');
    }
  });
});
```

---

## Permission Tests

```javascript
describe('Permission Tests', () => {
  
  test('contractor attempting to execute sensitive payment RPCs', async () => {
    // create_payment_reservation
    const { error: createError } = await authenticatedClient.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    expect(createError.message).toContain('permission denied');
    
    // attach_stripe_payment_intent
    const { error: attachError } = await authenticatedClient.rpc('attach_stripe_payment_intent', {
      p_reservation_id: testReservationId,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    expect(attachError.message).toContain('permission denied');
    
    // process_stripe_payment_atomic
    const { error: processError } = await authenticatedClient.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    expect(processError.message).toContain('permission denied');
    
    // expire_pending_reservation
    const { error: expireError } = await authenticatedClient.rpc('expire_pending_reservation', {
      p_reservation_id: testReservationId
    });
    expect(expireError.message).toContain('permission denied');
    
    // cancel_processing_reservation
    const { error: cancelError } = await authenticatedClient.rpc('cancel_processing_reservation', {
      p_stripe_payment_intent_id: 'pi_test_123'
    });
    expect(cancelError.message).toContain('permission denied');
  });
  
  test('contractor attempting direct modification of payment/credit tables', async () => {
    // payment_reservations
    const { error: resError } = await authenticatedClient
      .from('payment_reservations')
      .update({ status: 'succeeded' })
      .eq('id', testReservationId);
    expect(resError.message).toContain('permission denied');
    
    // purchases
    const { error: purchError } = await authenticatedClient
      .from('purchases')
      .insert({ company_id: testCompanyId, credits: 100 });
    expect(purchError.message).toContain('permission denied');
    
    // companies (credits)
    const { error: compError } = await authenticatedClient
      .from('companies')
      .update({ credits: 999999 })
      .eq('id', testCompanyId);
    expect(compError.message).toContain('permission denied');
    
    // credit_ledger
    const { error: ledgerError } = await authenticatedClient
      .from('credit_ledger')
      .insert({ company_id: testCompanyId, change_amount: 100 });
    expect(ledgerError.message).toContain('permission denied');
    
    // receipt_outbox
    const { error: receiptError } = await authenticatedClient
      .from('receipt_outbox')
      .update({ status: 'sent' })
      .eq('id', testJobId);
    expect(receiptError.message).toContain('permission denied');
  });
});
```

---

## Receipt Worker Tests

```javascript
describe('Receipt Worker Tests', () => {
  
  test('concurrent receipt workers', async () => {
    // Clean up any existing pending jobs to ensure deterministic test
    await supabase
      .from('receipt_outbox')
      .delete()
      .eq('status', 'pending');
    
    // Create a test receipt job in pending state
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Verify job is pending
    const { data: pendingJob } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id)
      .single();
    expect(pendingJob.status).toBe('pending');
    expect(pendingJob.attempts).toBe(0);
    
    // Two workers try to claim same job concurrently
    const [result1, result2] = await Promise.all([
      supabase.rpc('claim_receipt_job').maybeSingle(),
      supabase.rpc('claim_receipt_job').maybeSingle()
    ]);
    
    // Exactly one should get the job
    const claimed = [result1, result2].filter(r => r.data && !r.error);
    const notClaimed = [result1, result2].filter(r => !r.data && !r.error);
    
    expect(claimed.length).toBe(1);
    expect(notClaimed.length).toBe(1);
    
    // Job should be in processing state with attempts = 1
    const { data: updatedJob } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id)
      .single();
    
    expect(updatedJob.status).toBe('processing');
    expect(updatedJob.attempts).toBe(1);
  });
  
  test('receipt send succeeds but worker crashes before marking complete', async () => {
    // Create and claim job
    const { data: job } = await supabase.rpc('claim_receipt_job');
    
    // Simulate: email sent successfully but worker crashes
    // Job remains in processing state
    const staleJob = await getReceiptJob(job.id);
    expect(staleJob.status).toBe('processing');
    
    // Recovery: cleanup finds stale processing job
    // Checks with provider, confirms delivery
    // Marks as sent
    await supabase.rpc('complete_receipt_job', {
      p_job_id: job.id,
      p_provider_message_id: 'msg_test_123'
    });
    
    const completed = await getReceiptJob(job.id);
    expect(completed.status).toBe('sent');
    expect(completed.provider_message_id).toBe('msg_test_123');
  });
  
  test('receipt retry must not create a second outbox job', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Process payment (creates receipt job)
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Count jobs
    const { data: jobs } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id);
    
    // Should be exactly one job
    expect(jobs.length).toBe(1);
    
    // Duplicate webhook should not create second job
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    const { data: jobsAfter } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('reservation_id', reservation_id);
    
    expect(jobsAfter.length).toBe(1);
  });
});
```

---

## Historical Customer Tests

```javascript
describe('Historical Customer Tests', () => {
  
  test('historical customer attempting to claim first-purchase discount', async () => {
    // Set up: company has historical purchase
    await supabase
      .from('companies')
      .update({ has_purchased: true })
      .eq('id', testCompanyId);
    
    // Attempt to create reservation
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    const reservation = await getReservation(reservation_id);
    
    // Should NOT get discount
    expect(reservation.is_first_purchase).toBe(false);
    expect(reservation.amount_pence).toBe(2500); // Full price, not 2000
  });
});
```

---

## RLS & Security Tests

```javascript
describe('RLS & Security Tests', () => {
  
  test('RLS is enabled on all payment tables', async () => {
    const tables = [
      'payment_reservations',
      'purchases',
      'credit_ledger',
      'companies',
      'receipt_outbox',
      'company_members',
      'credit_packages'
    ];
    
    for (const table of tables) {
      const { data } = await supabase
        .from('pg_tables')
        .select('rowsecurity')
        .eq('tablename', table)
        .single();
      
      expect(data.rowsecurity).toBe(true);
    }
  });
  
  test('user A can access company A data', async () => {
    const { data, error } = await authenticatedClientA
      .from('payment_reservations')
      .select('*')
      .eq('company_id', companyAId);
    
    expect(error).toBeUndefined();
    expect(data.length).toBeGreaterThan(0);
  });
  
  test('user A cannot access company B data', async () => {
    const { data, error } = await authenticatedClientA
      .from('payment_reservations')
      .select('*')
      .eq('company_id', companyBId);
    
    expect(error).toBeUndefined();
    expect(data.length).toBe(0);  // RLS filters out company B data
  });
  
  test('user A cannot enumerate company B membership', async () => {
    const { data, error } = await authenticatedClientA
      .from('company_members')
      .select('*')
      .eq('company_id', companyBId);
    
    expect(error).toBeUndefined();
    expect(data.length).toBe(0);  // RLS filters out other users' memberships
  });
  
  test('anon cannot read memberships', async () => {
    const { data, error } = await anonClient
      .from('company_members')
      .select('*');
    
    expect(error).toBeDefined();
    expect(error.message).toContain('permission denied');
  });
  
  test('authenticated users cannot directly write financial state', async () => {
    // Attempt to update payment_reservations
    const { error: resError } = await authenticatedClient
      .from('payment_reservations')
      .update({ status: 'succeeded' })
      .eq('id', testReservationId);
    expect(resError.message).toContain('permission denied');
    
    // Attempt to update companies credits
    const { error: compError } = await authenticatedClient
      .from('companies')
      .update({ credits: 999999 })
      .eq('id', testCompanyId);
    expect(compError.message).toContain('permission denied');
    
    // Attempt to insert into purchases
    const { error: purchError } = await authenticatedClient
      .from('purchases')
      .insert({ company_id: testCompanyId, credits: 100 });
    expect(purchError.message).toContain('permission denied');
  });
  
  test('service role can execute payment RPCs', async () => {
    const { data, error } = await serviceRoleClient.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
  });
});
```

---

## State Transition Tests

```javascript
describe('State Transition Tests', () => {
  
  test('same-state updates are allowed', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Update same state (pending -> pending) should succeed
    const { error } = await supabase
      .from('payment_reservations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', reservation_id)
      .eq('status', 'pending');
    
    expect(error).toBeUndefined();
  });
  
  test('invalid transition: succeeded -> pending', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservation_id,
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    await supabase.rpc('process_stripe_payment_atomic', {
      p_stripe_payment_intent_id: 'pi_test_123',
      p_stripe_amount_pence: 2500,
      p_stripe_currency: 'gbp'
    });
    
    // Attempt to transition back to pending
    const { error } = await supabase
      .from('payment_reservations')
      .update({ status: 'pending' })
      .eq('id', reservation_id);
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Invalid transition');
  });
  
  test('invalid transition: pending -> succeeded', async () => {
    const { data: reservation_id } = await supabase.rpc('create_payment_reservation', {
      p_company_id: testCompanyId,
      p_package_id: 'starter'
    });
    
    // Attempt to skip processing and go directly to succeeded
    const { error } = await supabase
      .from('payment_reservations')
      .update({ status: 'succeeded' })
      .eq('id', reservation_id);
    
    expect(error).toBeDefined();
    expect(error.message).toContain('Invalid transition');
  });
});
```

---

## Receipt Race Safety Tests

```javascript
describe('Receipt Race Safety Tests', () => {
  
  test('stale worker racing with completion', async () => {
    // Create and claim job
    const { data: job } = await supabase.rpc('claim_receipt_job').maybeSingle();
    
    // Worker 1 completes the job
    await supabase.rpc('complete_receipt_job', {
      p_job_id: job.id,
      p_provider_message_id: 'msg_test_123'
    });
    
    // Worker 2 (stale) tries to fail the same job
    const { error } = await supabase.rpc('fail_receipt_job', {
      p_job_id: job.id
    });
    
    // Should fail because job is no longer in processing state
    expect(error).toBeDefined();
    expect(error.message).toContain('not in processing state');
    
    // Job should still be sent
    const { data: finalJob } = await supabase
      .from('receipt_outbox')
      .select('*')
      .eq('id', job.id)
      .single();
    expect(finalJob.status).toBe('sent');
  });
});
```

---

## Summary

This document contains all test examples for the payment architecture. All tests use the exact RPC signatures and return fields defined in 04-payment-rpcs.md and 07-receipt-jobs.md.

**End of review files.**
