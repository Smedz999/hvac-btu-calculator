# 05-stripe-webhooks.md — Stripe Webhook Handler

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 04-payment-rpcs.md, 01-payment-flow.md

---

## Overview

This document contains the Stripe webhook handler logic.

**Authoritative definitions:**
- Webhook endpoint
- Webhook event flows
- Webhook recovery logic

---

## Webhook Handler

### Purpose
Handle Stripe webhook events with server-side verification and atomic payment processing.

### Endpoint
`POST /api/webhooks/stripe`

---

## Flow: `payment_intent.succeeded`

1. **Verify Signature**
   ```javascript
   const event = stripe.webhooks.constructEvent(
     req.body,
     req.headers['stripe-signature'],
     process.env.STRIPE_WEBHOOK_SECRET
   );
   ```

2. **Extract PaymentIntent**
   ```javascript
   const paymentIntent = event.data.object;
   ```

3. **Process Payment (Server-Side Verification)**
   ```javascript
   // Call exact RPC signature: process_stripe_payment_atomic(TEXT, INTEGER, TEXT)
   // Do NOT trust Stripe metadata for company, credits, package, amount, discount, or eligibility
   const { data, error } = await supabase.rpc('process_stripe_payment_atomic', {
     p_stripe_payment_intent_id: paymentIntent.id,
     p_stripe_amount_pence: paymentIntent.amount,
     p_stripe_currency: paymentIntent.currency
   }).single();  // Use .single() for single-row RPC results
   
   if (error) {
     console.error('Payment processing failed:', error);
     return res.status(500).json({ error: 'Processing failed' });
   }
   
   // Idempotent response — duplicate webhooks return same balance_after
   res.json({ 
     received: true, 
     already_processed: data.already_processed,
     balance_after: data.balance_after  // Original recorded balance, not current
   });
   ```

**See:** 04-payment-rpcs.md for `process_stripe_payment_atomic` RPC definition

---

## Webhook-Before-Attachment Recovery

If webhook arrives before PI is attached (crash between Stripe PI creation and DB attachment):
1. `process_stripe_payment_atomic` will fail with "Reservation not found"
2. Return 500 — Stripe will retry webhook
3. Cleanup job will reconcile: fetch PI from Stripe, attach if missing, then process
4. Credits are NEVER awarded based on Stripe metadata alone

---

## Flow: `payment_intent.payment_failed`

1. **Verify Signature** (same as above)

2. **Extract PaymentIntent**

3. **Do NOT Auto-Cancel**
   ```javascript
   // PaymentIntent may be retryable
   // Only Stripe 'canceled' state triggers cancellation
   // Do NOT release first-purchase eligibility on failure
   console.log('Payment failed, but may be retryable:', paymentIntent.id);
   res.json({ received: true });
   ```

---

## Flow: `payment_intent.canceled`

1. **Verify Signature**

2. **Cancel Reservation via RPC**
   ```javascript
   // Only confirmed Stripe cancelled state may transition reservation to cancelled
   const { error } = await supabase.rpc('cancel_processing_reservation', {
     p_stripe_payment_intent_id: paymentIntent.id
   });
   
   res.json({ received: true });
   ```

**See:** 04-payment-rpcs.md for `cancel_processing_reservation` RPC definition

---

## Duplicate Webhook Safety

- Duplicate `payment_intent.succeeded` webhooks are idempotent
- First call processes payment and returns `already_processed = FALSE`
- Subsequent calls return `already_processed = TRUE` with original `balance_after`
- Concurrent webhook calls are serialized by `FOR UPDATE` lock
- Only one concurrent call transitions reservation to `succeeded`
- Credits are never double-added

---

## Metadata Usage

Stripe PaymentIntent metadata is **NEVER** trusted for:
- Company ID
- Credits amount
- Package selection
- Payment amount
- Discount eligibility
- First-purchase status

Metadata may contain `reservation_id` as a **lookup hint only** for debugging/logging.

---

## Summary

This document contains the Stripe webhook handler logic. All webhook events are verified and processed using server-side RPC functions. Stripe metadata is never trusted for protected business data.

**Next:** See 06-reservations-discounts.md for discount logic and migration strategy.
