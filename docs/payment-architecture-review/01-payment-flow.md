# 01-payment-flow.md — End-to-End Payment Flow

**Status:** DRAFT — For independent review  
**Date:** 2026-08-30  
**Cross-references:** 02-database-tables.md, 03-rls-permissions.md, 04-payment-rpcs.md, 05-stripe-webhooks.md

---

## Overview

This document describes the complete end-to-end payment flow for ACConnx credit purchases.

**Authoritative definitions:**
- Table schemas: See 02-database-tables.md
- RLS policies: See 03-rls-permissions.md
- RPC functions: See 04-payment-rpcs.md
- Webhook handling: See 05-stripe-webhooks.md

---

## Flow 1: Create Payment Intent

### Endpoint
`POST /api/create-payment-intent`

### Authentication
- Requires valid JWT token
- `company_id` resolved through `company_members` table, NOT from `user.id`

### Request Body
```json
{
  "package_id": "starter|growth|pro"
}
```

**Security Note:** Client must NOT send `company_id`, `credits`, `amount`, `discount`, or `is_first_purchase`. These are derived server-side only.

### Flow Steps

#### 1. Authenticate User
```javascript
const { user } = await supabase.auth.getUser(token);
if (!user) return res.status(401).json({ error: 'Unauthorized' });

// Resolve company through membership relationship
// NEVER assume user.id equals company_id
const { data: membership, error: membershipError } = await supabase
  .from('company_members')
  .select('company_id')
  .eq('user_id', user.id)
  .single();

if (membershipError || !membership) {
  return res.status(403).json({ error: 'No company membership found' });
}

const company_id = membership.company_id; // From membership lookup, not user.id
```

#### 2. Validate Package
```javascript
const { package_id } = req.body;
if (!['starter', 'growth', 'pro'].includes(package_id)) {
  return res.status(400).json({ error: 'Invalid package' });
}
```

#### 3. Create Reservation (Trusted Server-Side)
```javascript
// RPC derives: credits, amount_pence, is_first_purchase from database
// Client cannot override these values
const { data: reservation_id, error } = await supabase.rpc('create_payment_reservation', {
  p_company_id: company_id,  // From membership lookup, not client
  p_package_id: package_id
});

if (error) return res.status(500).json({ error: error.message });
```

**See:** 04-payment-rpcs.md for `create_payment_reservation` RPC definition

#### 4. Fetch Immutable Pricing Snapshot
```javascript
// Reservation now contains immutable pricing snapshot
const { data: reservation } = await supabase
  .from('payment_reservations')
  .select('*')
  .eq('id', reservation_id)
  .single();

// reservation.amount_pence is now locked and cannot be changed
// reservation.credits is derived from trusted credit_packages table
// reservation.is_first_purchase is determined by server-side query
```

#### 5. Create Stripe PaymentIntent with Idempotency Key
```javascript
// Use reservation.amount_pence (immutable snapshot), NOT client input
const paymentIntent = await stripe.paymentIntents.create({
  amount: reservation.amount_pence,
  currency: reservation.currency,
  metadata: {
    reservation_id: reservation_id  // Lookup hint only, not authoritative
  },
  receipt_email: user.email
}, {
  idempotencyKey: `reservation_${reservation_id}`
});
```

#### 6. Attach PaymentIntent to Reservation
```javascript
const { data: attachResult, error: attachError } = await supabase.rpc('attach_stripe_payment_intent', {
  p_reservation_id: reservation_id,
  p_stripe_payment_intent_id: paymentIntent.id,
  p_stripe_amount_pence: paymentIntent.amount,
  p_stripe_currency: paymentIntent.currency
}).single();  // Use .single() for single-row RPC results

if (attachError) {
  // Lost attachment recovery: cancel the Stripe PI
  await stripe.paymentIntents.cancel(paymentIntent.id);
  return res.status(500).json({ error: 'Failed to attach payment' });
}
```

**See:** 04-payment-rpcs.md for `attach_stripe_payment_intent` RPC definition

#### 7. Return Client Secret
```javascript
res.json({
  client_secret: paymentIntent.client_secret,
  reservation_id: reservation_id,
  amount: reservation.amount_pence,  // From immutable snapshot
  credits: reservation.credits        // From trusted package config
});
```

### Trust Boundaries

| Field | Source | Client Can Override? |
|-------|--------|---------------------|
| `company_id` | `company_members` lookup | ❌ NO |
| `credits` | `credit_packages` table | ❌ NO |
| `amount_pence` | `credit_packages` + discount logic | ❌ NO |
| `is_first_purchase` | `companies.has_purchased` query | ❌ NO |
| `package_id` | Request body | ✅ YES (validated) |

### Lost Attachment Recovery
If Stripe PI is created but DB attachment fails (crash, network error, etc.):

1. **Immediate Recovery (in endpoint)**
   - Cancel the Stripe PaymentIntent immediately
   - Mark reservation as expired
   - Return error to client
   - Client can retry with new reservation

2. **Delayed Recovery (cleanup job)**
   - If endpoint crashes before canceling Stripe PI, cleanup job will find it
   - Fetch PI from Stripe using metadata.reservation_id as lookup hint
   - If reservation still pending and PI exists: attach and process
   - If reservation expired: cancel the orphaned Stripe PI

3. **Webhook-Before-Attachment Safety**
   - Webhook arrives before PI is attached to reservation
   - `process_stripe_payment_atomic` looks up reservation by `stripe_payment_intent_id`
   - If not found: returns error (Stripe will retry webhook)
   - Credits are NEVER awarded based on Stripe metadata alone
   - Metadata.reservation_id is a lookup hint only, not authoritative

### Metadata Usage
Stripe PaymentIntent metadata contains `reservation_id` as a **lookup hint only**:
- Used by cleanup job to find orphaned PIs
- Used by webhook handler for logging/debugging
- **NEVER** used to award credits without database verification
- **NEVER** treated as authoritative for company, credits, or pricing

---

## Flow 2: Stripe Webhook Handler

### Endpoint
`POST /api/webhooks/stripe`

**See:** 05-stripe-webhooks.md for complete webhook handling logic

### Flow: `payment_intent.succeeded`

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

### Webhook-Before-Attachment Recovery
If webhook arrives before PI is attached (crash between Stripe PI creation and DB attachment):
1. `process_stripe_payment_atomic` will fail with "Reservation not found"
2. Return 500 — Stripe will retry webhook
3. Cleanup job will reconcile: fetch PI from Stripe, attach if missing, then process
4. Credits are NEVER awarded based on Stripe metadata alone

### Flow: `payment_intent.payment_failed`

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

### Flow: `payment_intent.canceled`

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

### Duplicate Webhook Safety
- Duplicate `payment_intent.succeeded` webhooks are idempotent
- First call processes payment and returns `already_processed = FALSE`
- Subsequent calls return `already_processed = TRUE` with original `balance_after`
- Concurrent webhook calls are serialized by `FOR UPDATE` lock
- Only one concurrent call transitions reservation to `succeeded`
- Credits are never double-added

### Metadata Usage
Stripe PaymentIntent metadata is **NEVER** trusted for:
- Company ID
- Credits amount
- Package selection
- Payment amount
- Discount eligibility
- First-purchase status

Metadata may contain `reservation_id` as a **lookup hint only** for debugging/logging.

---

## Flow 3: Cleanup/Reconciliation

### Purpose
Reconcile database state with Stripe state using real Stripe API queries. Never expire processing reservations based on time alone.

**See:** 04-payment-rpcs.md for `expire_pending_reservation` and `cancel_processing_reservation` RPC definitions

### Expiry Rules

| Reservation State | Stripe State | Action |
|-------------------|--------------|--------|
| `pending` | No PI attached | Expire if past `expires_at` |
| `pending` | PI exists | Fetch from Stripe, attach, then process |
| `processing` | `succeeded` | Process payment via `process_stripe_payment_atomic` RPC |
| `processing` | `canceled` | Cancel via `cancel_processing_reservation` RPC |
| `processing` | `requires_payment_method` | Leave active (retryable) |
| `processing` | `requires_confirmation` | Leave active (retryable) |
| `processing` | `requires_action` | Leave active (retryable) |
| `processing` | API lookup failure | Leave unchanged for later retry |

### Key Rules
- **Never expire processing without checking Stripe API**
- **Stripe succeeded → process payment via same RPC as webhook**
- **Only confirmed Stripe canceled → cancel via RPC**
- **Retryable states stay active indefinitely**
- **API failure leaves DB unchanged for later retry**
- **No `stripe_payment_intents` table** — always query Stripe API directly

### Cleanup Job (Every 15 Minutes)

```javascript
// 1. Expire pending reservations past expires_at with no PI attached
const { data: expiredPending } = await supabase
  .from('payment_reservations')
  .select('id')
  .eq('status', 'pending')
  .is('stripe_payment_intent_id', null)
  .lt('expires_at', new Date().toISOString());

for (const res of expiredPending) {
  // Idempotent: safe if multiple workers process same reservation
  await supabase.rpc('expire_pending_reservation', { p_reservation_id: res.id });
}

// 2. Reconcile processing reservations with Stripe API
// NOTE: We do NOT filter by expires_at for processing reservations
// Processing reservations never expire based on time alone
const { data: processing } = await supabase
  .from('payment_reservations')
  .select('id, stripe_payment_intent_id')
  .eq('status', 'processing');

for (const res of processing) {
  try {
    // Query real Stripe API for PaymentIntent state
    const pi = await stripe.paymentIntents.retrieve(res.stripe_payment_intent_id);
    
    if (pi.status === 'succeeded') {
      // Reconcile: process payment using same atomic RPC as webhook
      // This ensures consistent behavior between webhook and cleanup paths
      await supabase.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: pi.id,
        p_stripe_amount_pence: pi.amount,
        p_stripe_currency: pi.currency
      });
    } else if (pi.status === 'canceled') {
      // Only confirmed Stripe canceled state may transition to cancelled
      await supabase.rpc('cancel_processing_reservation', {
        p_stripe_payment_intent_id: pi.id
      });
    }
    // Retryable states (requires_payment_method, requires_confirmation, requires_action):
    // Leave unchanged — reservation stays active
  } catch (error) {
    // Stripe API failure: leave reservation unchanged for later retry
    console.error('Stripe lookup failed for reservation', res.id, error);
  }
}
```

### Concurrency Safety
- Multiple cleanup workers can run concurrently
- `FOR UPDATE` locks in RPCs prevent race conditions
- `expire_pending_reservation` is idempotent
- `process_stripe_payment_atomic` is idempotent (returns `already_processed = TRUE` on duplicate)
- `cancel_processing_reservation` is idempotent
- Stripe API failures leave reservations unchanged for later retry

### Retryable Stripe States
These states indicate the payment may still succeed:
- `requires_payment_method` — Customer needs to provide payment method
- `requires_confirmation` — Payment needs confirmation
- `requires_action` — Customer needs to complete 3D Secure or similar

**Processing reservations in these states remain active indefinitely** unless:
1. Business explicitly cancels via admin action
2. Stripe transitions to `canceled`
3. Stripe transitions to `succeeded`

### Lost Attachment Recovery
If Stripe PI exists but reservation has no `stripe_payment_intent_id`:
1. Cleanup job finds pending reservation past `expires_at`
2. Checks if PI exists in Stripe (using metadata.reservation_id as lookup hint)
3. If found: attaches PI and processes payment
4. If not found: expires the pending reservation

---

## Summary

This document describes the complete payment flow from creation to completion. All sensitive operations are performed server-side using trusted RPC functions. Client input is validated and never trusted for pricing, credits, or company identification.

**Next:** See 02-database-tables.md for table schemas and constraints.
