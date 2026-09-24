const express = require('express');
const rateLimit = require('express-rate-limit');
const { generateToken, generateAdminToken, requireAuth, requireAdmin, requireCronSecret } = require('./auth');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Web Push (VAPID)
let webpush = null;
try {
  webpush = require('web-push');
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails('mailto:admin@acconnx.com', vapidPublic, vapidPrivate);
    console.log('✅ Web Push initialized');
  } else {
    console.log('⚠️ VAPID keys not set — push notifications disabled');
    webpush = null;
  }
} catch (e) {
  console.log('⚠️ web-push not installed');
}

const app = express();

// Vercel puts exactly one trusted proxy hop (its own edge network) in front
// of this function, which always sets X-Forwarded-For to the real client
// IP. Without this, req.ip falls back to the internal socket peer address,
// which collapses express-rate-limit's per-client buckets into one shared
// bucket. Must stay a numeric hop count (not `true`) so a client cannot
// spoof extra X-Forwarded-For entries to bypass rate limiting.
app.set('trust proxy', 1);

const port = process.env.PORT || 3001;

// Supabase connection with better error handling
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

// Create Supabase client with options to handle JWT issues
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  global: {
    headers: {
      'X-Client-Info': 'acconnx-api'
    }
  }
});

// Add error handling wrapper for Supabase queries
async function safeQuery(queryFn) {
  try {
    return await queryFn();
  } catch (err) {
    // Check for JWT errors
    if (err.message && err.message.includes('JWT')) {
      console.error('JWT Error - check SUPABASE_SERVICE_KEY:', err.message);
      throw new Error('Database authentication error. Please check server configuration.');
    }
    throw err;
  }
}

console.log('✅ Supabase initialized');

// Initialize services
let stripe = null;
let resend = null;
let twilio = null;

try {
  if (process.env.STRIPE_SECRET_KEY) {
    const Stripe = require('stripe');
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
  }
} catch (e) {
  console.log('⚠️ Stripe not configured');
}

try {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resend = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Resend initialized');
  }
} catch (e) {
  console.log('⚠️ Resend not configured');
}

try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilioClient = require('twilio');
    twilio = twilioClient(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio initialized');
  }
} catch (e) {
  console.log('⚠️ Twilio not configured');
}

app.use(cors({ origin: ['https://acconnx.com', 'https://www.acconnx.com', 'http://localhost:3000', 'http://localhost:5000'] }));

// =====================
// STRIPE WEBHOOK (Migration 003 — Atomic RPC payment completion)
// =====================
// IMPORTANT: This route is registered BEFORE app.use(express.json()) below,
// and uses its own express.raw() body parser. Stripe signature verification
// requires the exact raw request bytes — if the global JSON body parser ran
// first, req.body would already be a parsed object by the time this handler
// runs, and constructEvent() would fail signature verification for every
// real webhook delivery.

// Verifies the webhook signature and parses the event. Split out from event
// handling so tests can exercise real signature verification (via the real
// `stripe` library and a real webhook secret) independently of RPC dispatch
// logic. `deps.stripeClient` defaults to the module-level `stripe` singleton
// — the real route below never passes a second argument, so production
// behavior is unchanged.
function verifyStripeWebhookSignature(req, deps = {}) {
  const { stripeClient = stripe } = deps;

  if (!stripeClient) {
    return { errorStatus: 503, errorBody: { error: 'Stripe not configured' } };
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set');
    return { errorStatus: 500, errorBody: { error: 'Webhook not configured' } };
  }

  try {
    const event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
    return { event };
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { errorStatus: 400, errorBody: { error: 'Invalid signature' } };
  }
}

// Dispatches an already-verified Stripe event to the atomic payment RPCs and
// returns the {status, body} the route should respond with. Pulled out of
// the route handler so tests can inject a fake Supabase client and assert on
// every branch (success, idempotent replay, unknown PaymentIntent, other RPC
// failure, cancellation, payment_failed, unrecognized event types) without a
// live database. `deps.supabaseClient` defaults to the module-level
// `supabase` singleton — the real route below never passes a second
// argument, so production behavior is unchanged.
async function handleStripeWebhookEvent(event, deps = {}) {
  const { supabaseClient = supabase } = deps;

  // Handle payment success — ONLY authority for crediting payments
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;

    try {
      // Call atomic RPC — handles reservation lookup, idempotency, credit grant,
      // purchase record, credit ledger, and receipt outbox in one transaction.
      // No Stripe metadata trust — RPC reads everything from payment_reservations table.
      const { data: result, error } = await supabaseClient.rpc('process_stripe_payment_atomic', {
        p_stripe_payment_intent_id: paymentIntent.id,
        p_stripe_amount_pence: paymentIntent.amount,
        p_stripe_currency: paymentIntent.currency
      }).single();

      if (error) {
        console.error(`❌ Webhook: process_stripe_payment_atomic failed for ${paymentIntent.id}:`, error.message);
        // Only ack (200) when NO reservation exists at all for this PaymentIntent —
        // that is genuinely permanent and retrying can never fix it.
        // Any other failure (e.g. "Invalid state for payment processing", which can
        // occur if a reservation was cancelled) must return non-2xx so Stripe retries
        // and the failure surfaces in the Stripe dashboard for manual investigation.
        // Silently 200-acking those would risk a paid transaction never being credited.
        if (error.message.includes('not found')) {
          return { status: 200, body: { received: true, error: error.message } };
        }
        return { status: 500, body: { error: 'Payment processing failed' } };
      }

      if (result.already_processed) {
        console.log(`✅ Webhook: Payment ${paymentIntent.id} already processed (idempotent)`);
      } else {
        console.log(`✅ Webhook: Payment ${paymentIntent.id} processed — ${result.credits_added} credits, balance ${result.balance_after}`);
      }
    } catch (err) {
      console.error('Webhook processing error:', err);
      return { status: 500, body: { error: 'Internal processing error' } };
    }
  }

  // Handle payment cancellation/failure — cancel the reservation
  if (event.type === 'payment_intent.canceled' || event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;

    if (event.type === 'payment_intent.canceled') {
      try {
        const { error } = await supabaseClient.rpc('cancel_processing_reservation', {
          p_stripe_payment_intent_id: paymentIntent.id
        }).single();

        if (error) {
          console.error(`Webhook: cancel_processing_reservation failed for ${paymentIntent.id}:`, error.message);
        } else {
          console.log(`✅ Webhook: Reservation cancelled for PI ${paymentIntent.id}`);
        }
      } catch (err) {
        console.error('Webhook cancel error:', err);
      }
    }

    // payment_intent.payment_failed: do NOT credit or cancel automatically.
    // The reservation stays in 'processing' — customer can retry payment.
    if (event.type === 'payment_intent.payment_failed') {
      console.log(`⚠️ Webhook: Payment failed for PI ${paymentIntent.id} — reservation remains in processing`);
    }
  }

  return { status: 200, body: { received: true } };
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const verification = verifyStripeWebhookSignature(req);
  if (verification.errorStatus) {
    return res.status(verification.errorStatus).json(verification.errorBody);
  }

  const result = await handleStripeWebhookEvent(verification.event);
  res.status(result.status).json(result.body);
});

app.use(express.json());

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 leads per hour per IP
  message: { error: 'Too many submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// =====================
// HEALTH CHECK
// =====================
app.get('/api/health', async (req, res) => {
  try {
    // Test database connection with a simple query
    const { count: companies, error: compError } = await supabase.from('companies').select('*', { count: 'exact', head: true });
    if (compError) throw compError;
    
    const { count: leads, error: leadError } = await supabase.from('leads').select('*', { count: 'exact', head: true });
    if (leadError) throw leadError;
    
    const { count: purchases, error: purError } = await supabase.from('purchases').select('*', { count: 'exact', head: true });
    if (purError) throw purError;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      stripe: !!stripe,
      resend: !!resend,
      twilio: !!twilio,
      database: 'supabase-connected',
      companies: companies || 0,
      leads: leads || 0,
      purchases: purchases || 0
    });
  } catch (err) {
    // Check for JWT errors specifically
    if (err.message && (err.message.includes('JWT') || err.message.includes('jwt'))) {
      return res.status(503).json({ 
        status: 'error',
        error: 'Database authentication failed',
        message: 'JWT token issue - check SUPABASE_SERVICE_KEY in environment variables',
        timestamp: new Date().toISOString()
      });
    }
    res.status(500).json({ 
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =====================
// COMPANIES
// =====================
app.post('/api/companies/register', authLimiter, async (req, res) => {
  try {
    const { company, name, email, phone, password, postcode, radius, fgas_number, coverage_areas } = req.body;

    if (!company || !name || !email || !phone || !password || !postcode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('companies')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Default coverage areas to the postcode prefix if not provided
    const defaultCoverage = coverage_areas || [postcode.toUpperCase().split(' ')[0]];

    // Build insert object - only include coverage_areas if column exists
    const insertData = {
      company,
      name,
      email,
      phone,
      password: hashedPassword,
      postcode: postcode.toUpperCase(),
      radius: radius || 25,
      credits: 5,
      fgas_number: fgas_number || null
    };

    // Try to insert with coverage_areas, retry without if column doesn't exist
    let result = await supabase
      .from('companies')
      .insert({ ...insertData, coverage_areas: defaultCoverage })
      .select()
      .single();

    if (result.error && result.error.message && result.error.message.includes('coverage_areas')) {
      result = await supabase
        .from('companies')
        .insert(insertData)
        .select()
        .single();
    }

    if (result.error) throw result.error;
    const companyData = result.data;

    // Send welcome email
    if (resend) {
      try {
        await resend.emails.send({
          from: 'ACConnx <onboarding@acconnx.com>',
          to: email,
          subject: 'Welcome to ACConnx!',
          html: `<h1>Welcome ${name}!</h1><p>Your company ${company} is now registered with 5 free credits.</p><p><a href="https://acconnx.com/company-portal.html">Login to your dashboard</a></p>`
        });
      } catch (e) {
        console.log('Failed to send welcome email:', e.message);
      }
    }

    delete companyData.password;
    const token = generateToken(companyData);
    res.json({ success: true, company: companyData, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: company, error } = await supabase
      .from('companies')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !company) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, company.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    delete company.password;
    const token = generateToken(company);
    res.json({ success: true, company, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin login endpoint — uses timing-safe comparison
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  if (password === adminPassword) {
    const token = generateAdminToken();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Invalid admin password' });
  }
});

// =====================
// PASSWORD RESET (Supabase-backed)
// =====================

app.post('/api/companies/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Always return success (security best practice)
    const { data: company } = await supabase
      .from('companies')
      .select('id, email')
      .eq('email', email)
      .single();

    if (company) {
      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

      // Delete any existing reset codes for this email
      await supabase
        .from('password_reset_codes')
        .delete()
        .eq('email', email.toLowerCase());

      // Store reset code in Supabase
      const { error: insertError } = await supabase
        .from('password_reset_codes')
        .insert({
          email: email.toLowerCase(),
          code,
          expires_at: expiresAt
        });

      if (insertError) {
        console.error('Failed to store reset code:', insertError.message);
      }

      // Send email via Resend
      if (resend) {
        try {
          await resend.emails.send({
            from: 'ACConnx <noreply@acconnx.com>',
            to: email,
            subject: 'Password Reset Code — ACConnx',
            html: `<h1>Password Reset</h1><p>Your password reset code is:</p><h2 style="font-size:2rem;letter-spacing:0.3em;color:#0a2540;">${code}</h2><p>This code expires in 15 minutes.</p><p>If you didn't request this, you can ignore this email.</p>`
          });
        } catch (e) {
          console.log('Failed to send reset email:', e.message);
        }
      }
    }

    // Always return success regardless of whether email exists
    res.json({ success: true, message: 'If an account exists, a reset code has been sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Look up reset code from Supabase
    const { data: stored, error: lookupError } = await supabase
      .from('password_reset_codes')
      .select('*')
      .eq('email', email.toLowerCase())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (lookupError || !stored) {
      return res.status(400).json({ error: 'No reset code found. Please request a new one.' });
    }

    if (new Date() > new Date(stored.expires_at)) {
      // Clean up expired code
      await supabase
        .from('password_reset_codes')
        .delete()
        .eq('email', email.toLowerCase());
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }

    if (stored.code !== code) {
      return res.status(400).json({ error: 'Invalid reset code.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update company password
    const { data: company, error } = await supabase
      .from('companies')
      .update({ password: hashedPassword, updated_at: new Date().toISOString() })
      .eq('email', email)
      .select('id, company, name, email')
      .single();

    if (error || !company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Delete the used reset code
    await supabase
      .from('password_reset_codes')
      .delete()
      .eq('email', email.toLowerCase());

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companies', requireAdmin, async (req, res) => {
  try {
    // Try to select with coverage_areas first
    let result = await supabase
      .from('companies')
      .select('id, company, name, email, phone, postcode, radius, credits, coverage_areas, created_at, updated_at');
    
    // If error mentions coverage_areas, retry without it
    if (result.error && result.error.message && result.error.message.includes('coverage_areas')) {
      result = await supabase
        .from('companies')
        .select('id, company, name, email, phone, postcode, radius, credits, created_at, updated_at');
      // Add empty coverage_areas to each company
      if (result.data) result.data.forEach(c => c.coverage_areas = []);
    }

    if (result.error) throw result.error;
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companies/:id', requireAuth, async (req, res) => {
  try {
    // Non-admin users can only view their own record
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.id) {
      return res.status(403).json({ error: 'You can only view your own company' });
    }

    let result = await supabase
      .from('companies')
      .select('id, company, name, email, phone, postcode, radius, credits, coverage_areas, created_at, updated_at')
      .eq('id', req.params.id)
      .single();
    
    if (result.error && result.error.message && result.error.message.includes('coverage_areas')) {
      result = await supabase
        .from('companies')
        .select('id, company, name, email, phone, postcode, radius, credits, created_at, updated_at')
        .eq('id', req.params.id)
        .single();
      if (result.data) result.data.coverage_areas = [];
    }

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Company not found' });

    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/companies/:id', requireAuth, async (req, res) => {
  try {
    // Contractors can only update their own record; admins can update any
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.id) {
      return res.status(403).json({ error: 'You can only update your own company' });
    }
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.id;
    delete updates.password;
    // Credits can ONLY be changed via /api/admin/adjust-credits (atomic RPC)
    // Block ALL credit modifications through this generic route — including admin
    delete updates.credits;

    let result = await supabase
      .from('companies')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, company, name, email, phone, postcode, radius, credits, coverage_areas, created_at, updated_at')
      .single();
    
    if (result.error && result.error.message && result.error.message.includes('coverage_areas')) {
      result = await supabase
        .from('companies')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, company, name, email, phone, postcode, radius, credits, created_at, updated_at')
        .single();
      if (result.data) result.data.coverage_areas = [];
    }

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Company not found' });

    res.json({ success: true, company: result.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// LEADS
// =====================
app.post('/api/leads', leadLimiter, async (req, res) => {
  try {
    const { customerName, customerEmail, customerPhone, postcode, btu, roomType, propertyType, notes } = req.body;

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        postcode: postcode?.toUpperCase(),
        btu,
        room_type: roomType,
        property_type: propertyType,
        status: 'new'
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-distribute to matching companies
    const distributed = await distributeLead(lead);

    res.json({ success: true, lead, distributed: distributed || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contractors can only ever move a lead through these statuses from the
// portal UI (see company-portal.html updateLeadStatus callers). 'new' is
// set only at lead creation and is deliberately excluded here so a
// contractor cannot revert a lead back to unclaimed.
const CONTRACTOR_ALLOWED_STATUSES = ['contacted', 'won', 'lost'];

// Returns { data, error } on success, or { forbidden: true } for any role
// other than 'admin'/'contractor' (fail closed, never inferred from an
// absent/undefined identity).
async function getLeadsForUser(user, companyIdParam, supabaseClient) {
  if (user.role === 'admin') {
    let query = supabaseClient.from('leads').select('*').order('created_at', { ascending: false });
    if (companyIdParam) query = query.eq('assigned_to', companyIdParam);
    const { data, error } = await query;
    return { data, error };
  }
  if (user.role === 'contractor') {
    // Ownership is derived only from the verified JWT — any client-supplied
    // companyId is ignored so it cannot be used to read another company's leads.
    const { data, error } = await supabaseClient
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .eq('assigned_to', user.id);
    return { data, error };
  }
  return { forbidden: true };
}

// Returns { data, error } on success, { invalidStatus: true }, or
// { forbidden: true } for any role other than 'admin'/'contractor'.
async function updateLeadForUser(user, leadId, body, supabaseClient) {
  if (user.role === 'admin') {
    const updates = { ...body, updated_at: new Date().toISOString() };
    delete updates.id;
    const { data, error } = await supabaseClient
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .select()
      .maybeSingle();
    return { data, error };
  }
  if (user.role === 'contractor') {
    if (!CONTRACTOR_ALLOWED_STATUSES.includes(body.status)) {
      return { invalidStatus: true };
    }
    // Only status is ever written, and the WHERE clause enforces ownership
    // atomically as part of the same update — a non-owner's request matches
    // zero rows rather than being checked-then-acted-on separately.
    const updates = { status: body.status, updated_at: new Date().toISOString() };
    const { data, error } = await supabaseClient
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .eq('assigned_to', user.id)
      .select()
      .maybeSingle();
    return { data, error };
  }
  return { forbidden: true };
}

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const result = await getLeadsForUser(req.user, req.query.companyId, supabase);
    if (result.forbidden) return res.status(403).json({ error: 'Forbidden' });
    if (result.error) throw result.error;
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const result = await updateLeadForUser(req.user, req.params.id, req.body, supabase);
    if (result.forbidden) return res.status(403).json({ error: 'Forbidden' });
    if (result.invalidStatus) return res.status(400).json({ error: 'Invalid status' });
    if (result.error) throw result.error;
    // Same 404 whether the id doesn't exist or exists but isn't owned by
    // this contractor — never reveal which case it is.
    if (!result.data) return res.status(404).json({ error: 'Lead not found' });

    res.json({ success: true, lead: result.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// STRIPE PAYMENTS (Migration 003 — Reservation Architecture)
// =====================
// NOTE: No hardcoded CREDIT_PACKAGES. Database credit_packages table is authoritative.
// Migration 003 seeds starter/5/£49.99, professional/15/£129.99, business/30/£199.99.

// Helper: fetch package from DB (authoritative)
async function getPackage(packageId) {
  const { data, error } = await supabase
    .from('credit_packages')
    .select('*')
    .eq('id', packageId)
    .eq('active', true)
    .single();
  if (error || !data) return null;
  return data;
}

app.post('/api/create-payment-intent', requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  try {
    const { packageId } = req.body;
    const companyId = req.user.id; // JWT only — never from client body

    if (!packageId) {
      return res.status(400).json({ error: 'packageId is required' });
    }

    // Step 1: Create reservation via RPC (validates package, calculates discount server-side)
    const { data: reservationId, error: createErr } = await supabase.rpc('create_payment_reservation', {
      p_company_id: companyId,
      p_package_id: packageId
    });

    if (createErr) {
      console.error('create_payment_reservation failed:', createErr.message);
      return res.status(400).json({ error: createErr.message });
    }

    // Step 2: Read reservation amount/currency from DB (never trust client)
    const { data: reservation, error: fetchErr } = await supabase
      .from('payment_reservations')
      .select('amount_pence, currency, credits, is_first_purchase')
      .eq('id', reservationId)
      .single();

    if (fetchErr || !reservation) {
      console.error('Failed to fetch reservation:', fetchErr?.message);
      return res.status(500).json({ error: 'Failed to create payment reservation' });
    }

    // Step 3: Create Stripe PaymentIntent using reservation values
    const paymentIntent = await stripe.paymentIntents.create({
      amount: reservation.amount_pence,
      currency: reservation.currency,
      metadata: {
        reservation_id: reservationId
        // No companyId, credits, packageId, or discount in metadata — webhook reads from DB
      }
    });

    // Step 4: Attach PaymentIntent to reservation
    const { error: attachErr } = await supabase.rpc('attach_stripe_payment_intent', {
      p_reservation_id: reservationId,
      p_stripe_payment_intent_id: paymentIntent.id,
      p_stripe_amount_pence: reservation.amount_pence,
      p_stripe_currency: reservation.currency
    });

    if (attachErr) {
      console.error('attach_stripe_payment_intent failed:', attachErr.message);
      // Cancel the Stripe PaymentIntent since we can't attach it
      try { await stripe.paymentIntents.cancel(paymentIntent.id); } catch (e) { /* ignore */ }
      return res.status(500).json({ error: 'Failed to attach payment to reservation' });
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      reservationId,
      amount: reservation.amount_pence,
      currency: reservation.currency,
      credits: reservation.credits,
      isFirstPurchase: reservation.is_first_purchase
    });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================
// ADMIN — Credit Adjustments (atomic via RPC)
// =====================
app.post('/api/admin/adjust-credits', requireAdmin, async (req, res) => {
  try {
    const { companyId, delta, reason } = req.body;

    if (!companyId || delta === undefined || !reason) {
      return res.status(400).json({ error: 'companyId, delta, and reason are required' });
    }

    if (typeof delta !== 'number' || delta === 0) {
      return res.status(400).json({ error: 'delta must be a non-zero number' });
    }

    const { data: result, error } = await supabase.rpc('admin_adjust_credits', {
      p_company_id: companyId,
      p_delta: delta,
      p_reason: reason
    }).single();

    if (error) {
      console.error('admin_adjust_credits failed:', error.message);
      return res.status(400).json({ error: error.message });
    }

    res.json({
      success: true,
      newBalance: result.new_balance,
      adjustmentApplied: result.adjustment_applied
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// RECEIPT WORKER (protected internal endpoint)
// =====================
async function processReceiptJobs(req, res) {
  try {
    // Reclaim jobs stuck in 'processing' for >10 minutes (e.g. a prior
    // invocation crashed/timed out after claiming but before completing)
    // before claiming any new work.
    try {
      await supabase.rpc('reclaim_stale_receipt_jobs');
    } catch (reclaimErr) {
      console.error('Stale receipt-job reclaim failed:', reclaimErr.message);
    }

    const results = { claimed: 0, sent: 0, failed: 0, errors: [] };

    // Process up to 10 jobs per invocation
    for (let i = 0; i < 10; i++) {
      // Claim next pending job
      const { data: job, error: claimErr } = await supabase.rpc('claim_receipt_job').maybeSingle();

      if (claimErr) {
        results.errors.push(`Claim error: ${claimErr.message}`);
        break;
      }

      if (!job) break; // No more pending jobs

      results.claimed++;

      try {
        // Fetch company email for receipt
        const { data: company } = await supabase
          .from('companies')
          .select('email, name, company')
          .eq('id', job.company_id)
          .single();

        if (!company || !company.email) {
          throw new Error(`Company ${job.company_id} has no email`);
        }

        // Send receipt email via Resend
        if (!resend) {
          throw new Error('Resend not configured');
        }

        const emailResult = await resend.emails.send({
          from: 'ACConnx <receipts@acconnx.com>',
          to: company.email,
          subject: 'Payment Confirmation - ACConnx',
          html: `<h1>Thank you for your purchase!</h1>
            <p>You bought ${job.credits_added} credits for £${(job.amount_pence / 100).toFixed(2)}.</p>
            <p>Your new balance: ${job.balance_after} credits</p>
            <p><a href="https://acconnx.com/company-portal.html">View Dashboard</a></p>`
        }, {
          idempotencyKey: `receipt/${job.reservation_id}`
        });

        if (emailResult?.error) {
          throw new Error(`Resend error: ${emailResult.error.message || JSON.stringify(emailResult.error)}`);
        }

        const providerMessageId = emailResult?.id || emailResult?.data?.id;

        if (!providerMessageId) {
          throw new Error('Resend response missing a valid provider message id');
        }

        // Mark job as sent
        await supabase.rpc('complete_receipt_job', {
          p_job_id: job.id,
          p_provider_message_id: providerMessageId
        });

        // Update reservation receipt_sent_at
        await supabase
          .from('payment_reservations')
          .update({ receipt_sent_at: new Date().toISOString() })
          .eq('id', job.reservation_id);

        results.sent++;
      } catch (sendErr) {
        console.error(`Receipt send failed for job ${job.id}:`, sendErr.message);

        // Mark job as failed (will retry or permanently fail after 5 attempts)
        try {
          await supabase.rpc('fail_receipt_job', { p_job_id: job.id });
        } catch (failErr) {
          results.errors.push(`Fail RPC error for job ${job.id}: ${failErr.message}`);
        }

        results.failed++;
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Manual/admin trigger (existing behavior, unchanged auth)
app.post('/api/internal/process-receipts', requireAdmin, processReceiptJobs);
// Machine trigger for the external scheduler (GitHub Actions), separate auth
app.get('/api/internal/process-receipts', requireCronSecret, processReceiptJobs);

// =====================
// ADMIN
// =====================
app.get('/api/admin/purchases', requireAdmin, async (req, res) => {
  try {
    const { data: purchases, error } = await supabase
      .from('purchases')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const { data: purchases } = await supabase.from('purchases').select('*');
    const { count: totalCompanies } = await supabase.from('companies').select('*', { count: 'exact', head: true });
    const { count: totalLeads } = await supabase.from('leads').select('*', { count: 'exact', head: true }).is('assigned_to', null);
    const { count: distributedLeads } = await supabase.from('leads').select('*', { count: 'exact', head: true }).not('assigned_to', 'is', null);
    const { count: wonLeads } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'won');

    const totalRevenue = (purchases || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalCompanies: totalCompanies || 0,
      totalLeads: totalLeads || 0,
      distributedLeads: distributedLeads || 0,
      totalCredits: (purchases || []).reduce((sum, p) => sum + (p.credits || 0), 0),
      conversionRate: distributedLeads > 0 ? Math.round((wonLeads / distributedLeads) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// LEAD DISTRIBUTION
// =====================
// `deps` lets tests substitute the Supabase client, Resend client, and push
// sender without changing any behavior when called with no second argument
// (the real call site in POST /api/leads passes none, so production always
// uses the same module-level singletons it always has).
async function distributeLead(lead, deps = {}) {
  const {
    supabaseClient = supabase,
    resendClient = resend,
    sendPush = sendPushToCompany
  } = deps;

  try {
    const leadPrefix = lead.postcode?.split(' ')[0];
    if (!leadPrefix) return [];

    // Find eligible companies (have credits, matching coverage area)
    // Check if lead prefix matches any of the company's coverage areas
    const { data: allCompanies, error } = await supabaseClient
      .from('companies')
      .select('*')
      .gt('credits', 0);

    if (error) throw error;
    if (!allCompanies || allCompanies.length === 0) return [];

    // Filter companies whose coverage areas include the lead prefix
    const eligible = allCompanies.filter(company => {
      // If no coverage areas set, fall back to old postcode matching
      if (!company.coverage_areas || company.coverage_areas.length === 0) {
        const companyPrefix = company.postcode?.split(' ')[0];
        return companyPrefix === leadPrefix ||
               companyPrefix?.substring(0, 2) === leadPrefix.substring(0, 2);
      }
      // Check if any coverage area matches the lead prefix
      return company.coverage_areas.some(area =>
        leadPrefix.startsWith(area) || area.startsWith(leadPrefix)
      );
    });

    if (eligible.length === 0) return [];

    // Count leads already received per company
    const companyIds = eligible.map(c => c.id);
    const { data: leadCounts } = await supabaseClient
      .from('leads')
      .select('assigned_to')
      .in('assigned_to', companyIds)
      .not('assigned_to', 'is', null);

    // Build lead count map
    const countMap = {};
    eligible.forEach(c => { countMap[c.id] = 0; });
    if (leadCounts) {
      leadCounts.forEach(l => {
        if (countMap[l.assigned_to] !== undefined) {
          countMap[l.assigned_to]++;
        }
      });
    }

    // Sort by fewest leads received, then by most credits as tiebreaker
    eligible.sort((a, b) => {
      const countDiff = (countMap[a.id] || 0) - (countMap[b.id] || 0);
      if (countDiff !== 0) return countDiff;
      return b.credits - a.credits;
    });

    // Take top 3
    const selected = eligible.slice(0, 3);
    const notifiedCompanies = [];

    // Primary contractor: assign_primary_lead() atomically locks the
    // company row, verifies credits, claims the original lead (only if
    // still unassigned), deducts one credit, and writes the ledger entry
    // — all in one transaction. No credit arithmetic happens here in
    // JavaScript, and notifications only fire once status === 'assigned'.
    const firstCompany = selected[0];
    const { data: primaryResult, error: primaryError } = await supabaseClient
      .rpc('assign_primary_lead', {
        p_lead_id: lead.id,
        p_company_id: firstCompany.id
      })
      .maybeSingle();

    if (primaryError) {
      console.error(`Primary lead assignment RPC error for company ${firstCompany.id}:`, primaryError.message);
    } else if (!primaryResult || primaryResult.status !== 'assigned') {
      console.error(`Primary lead assignment not completed for company ${firstCompany.id}: ${primaryResult?.status || 'no result'}`);
    } else {
      notifiedCompanies.push(firstCompany.company);

      if (resendClient) {
        try {
          await resendClient.emails.send({
            from: 'ACConnx <leads@acconnx.com>',
            to: firstCompany.email,
            subject: '🔥 New Lead: ' + lead.customer_name + ' - ' + lead.postcode,
            html: `<h1>New Lead Alert!</h1>
              <p><strong>Customer:</strong> ${lead.customer_name}</p>
              <p><strong>Email:</strong> ${lead.customer_email}</p>
              <p><strong>Phone:</strong> ${lead.customer_phone || 'Not provided'}</p>
              <p><strong>Postcode:</strong> ${lead.postcode}</p>
              <p><strong>BTU Required:</strong> ${lead.btu?.toLocaleString() || 'Not calculated'}</p>
              <p><strong>Room Type:</strong> ${lead.room_type || 'Not specified'}</p>
              <p><a href="https://acconnx.com/company-portal.html">View in Dashboard</a></p>
              <p><em>Contact within 15 minutes for best results!</em></p>`
          });
        } catch (e) {
          console.log('Failed to send lead notification:', e.message);
        }
      }

      try {
        await sendPush(firstCompany.id, {
          title: '🔥 New Lead!',
          body: `${lead.customer_name} — ${lead.postcode}${lead.btu ? ' — ' + lead.btu.toLocaleString() + ' BTU' : ''}`,
          url: '/company-portal.html#leads',
          tag: 'lead-' + Date.now()
        });
      } catch (e) {
        console.log('Failed to send push notification:', e.message);
      }
    }

    // Secondary contractors: assign_secondary_lead() atomically creates
    // the child lead row (with parent_lead_id), deducts one credit, and
    // writes the ledger entry as a single transaction — JavaScript no
    // longer inserts the lead row or touches credits directly here.
    for (let i = 1; i < selected.length; i++) {
      const company = selected[i];

      const { data: secondaryResult, error: secondaryError } = await supabaseClient
        .rpc('assign_secondary_lead', {
          p_parent_lead_id: lead.id,
          p_company_id: company.id,
          p_customer_name: lead.customer_name,
          p_customer_email: lead.customer_email,
          p_customer_phone: lead.customer_phone,
          p_postcode: lead.postcode,
          p_btu: lead.btu,
          p_room_type: lead.room_type,
          p_property_type: lead.property_type
        })
        .maybeSingle();

      if (secondaryError) {
        console.error(`Secondary lead assignment RPC error for company ${company.id}:`, secondaryError.message);
        continue;
      }

      if (!secondaryResult || secondaryResult.status !== 'assigned') {
        console.error(`Secondary lead assignment not completed for company ${company.id}: ${secondaryResult?.status || 'no result'}`);
        continue;
      }

      notifiedCompanies.push(company.company);

      // Send email notification
      if (resendClient) {
        try {
          await resendClient.emails.send({
            from: 'ACConnx <leads@acconnx.com>',
            to: company.email,
            subject: '🔥 New Lead: ' + lead.customer_name + ' - ' + lead.postcode,
            html: `<h1>New Lead Alert!</h1>
              <p><strong>Customer:</strong> ${lead.customer_name}</p>
              <p><strong>Email:</strong> ${lead.customer_email}</p>
              <p><strong>Phone:</strong> ${lead.customer_phone || 'Not provided'}</p>
              <p><strong>Postcode:</strong> ${lead.postcode}</p>
              <p><strong>BTU Required:</strong> ${lead.btu?.toLocaleString() || 'Not calculated'}</p>
              <p><strong>Room Type:</strong> ${lead.room_type || 'Not specified'}</p>
              <p><a href="https://acconnx.com/company-portal.html">View in Dashboard</a></p>
              <p><em>Contact within 15 minutes for best results!</em></p>`
          });
        } catch (e) {
          console.log('Failed to send lead notification:', e.message);
        }
      }

      // Send push notification
      try {
        await sendPush(company.id, {
          title: '🔥 New Lead!',
          body: `${lead.customer_name} — ${lead.postcode}${lead.btu ? ' — ' + lead.btu.toLocaleString() + ' BTU' : ''}`,
          url: '/company-portal.html#leads',
          tag: 'lead-' + Date.now()
        });
      } catch (e) {
        console.log('Failed to send push notification:', e.message);
      }
    }

    return notifiedCompanies;
  } catch (err) {
    console.error('Lead distribution error:', err);
    return [];
  }
}

// =====================
// CRM — PROSPECTS
// =====================
app.get('/api/prospects', requireAdmin, async (req, res) => {
  try {
    const { data: prospects, error } = await supabase
      .from('prospects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(prospects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospects', requireAdmin, async (req, res) => {
  try {
    const { company, name, email, phone, city, postcode, status, notes } = req.body;

    if (!company || !name || !email) {
      return res.status(400).json({ error: 'Company, name, and email are required' });
    }

    const { data: prospect, error } = await supabase
      .from('prospects')
      .insert({
        company,
        contact: name,
        email,
        phone,
        city,
        status: status || 'new',
        notes
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, prospect });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prospects/:id', requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString(), last_contact: new Date().toISOString() };
    delete updates.id;

    const { data: prospect, error } = await supabase
      .from('prospects')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    res.json({ success: true, prospect });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/prospects/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('prospects')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// CRM — TASKS
// =====================
app.get('/api/tasks', requireAdmin, async (req, res) => {
  try {
    const { data: tasks, error } = await supabase
      .from('tasks')
      .select('*')
      .order('due_date', { ascending: true });

    if (error) throw error;
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', requireAdmin, async (req, res) => {
  try {
    const { title, description, dueDate, prospectId } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        title,
        description,
        due_date: dueDate,
        prospect_id: prospectId
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.id;

    const { data: task, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!task) return res.status(404).json({ error: 'Task not found' });

    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('tasks')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// PUSH NOTIFICATIONS
// =====================

// Get VAPID public key (client needs this to subscribe)
app.get('/api/push/vapid-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey });
});

// Subscribe to push notifications
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { companyId, subscription } = req.body;

    if (!companyId || !subscription) {
      return res.status(400).json({ error: 'companyId and subscription are required' });
    }

    // Store subscription in company record
    const { data, error } = await supabase
      .from('companies')
      .update({
        push_subscription: JSON.stringify(subscription),
        push_enabled: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', companyId)
      .select('id')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Company not found' });

    console.log(`📱 Push subscribed for company ${companyId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { companyId } = req.body;

    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }

    const { error } = await supabase
      .from('companies')
      .update({
        push_subscription: null,
        push_enabled: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', companyId);

    if (error) throw error;

    console.log(`📱 Push unsubscribed for company ${companyId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send push notification to a specific contractor
app.post('/api/push/notify', requireAuth, async (req, res) => {
  try {
    const { companyId, title, body, url, tag } = req.body;

    if (!companyId || !title || !body) {
      return res.status(400).json({ error: 'companyId, title, and body are required' });
    }

    const result = await sendPushToCompany(companyId, { title, body, url, tag });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: send push notification to a company
async function sendPushToCompany(companyId, { title, body, url, tag }) {
  if (!webpush) {
    console.log('⚠️ Push not configured, skipping notification');
    return { success: false, reason: 'push_not_configured' };
  }

  try {
    // Get company's push subscription
    const { data: company, error } = await supabase
      .from('companies')
      .select('push_subscription, push_enabled')
      .eq('id', companyId)
      .single();

    if (error || !company) {
      return { success: false, reason: 'company_not_found' };
    }

    if (!company.push_enabled || !company.push_subscription) {
      return { success: false, reason: 'not_subscribed' };
    }

    const subscription = JSON.parse(company.push_subscription);

    const payload = JSON.stringify({
      title: title || 'ACConnx',
      body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-72x72.png',
      tag: tag || 'acconnx-lead',
      data: { url: url || '/company-portal.html' },
      requireInteraction: true
    });

    await webpush.sendNotification(subscription, payload);
    console.log(`📱 Push sent to company ${companyId}: ${title}`);
    return { success: true };
  } catch (err) {
    // If subscription is expired/invalid, clean it up
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log(`📱 Push subscription expired for company ${companyId}, cleaning up`);
      await supabase
        .from('companies')
        .update({ push_subscription: null, push_enabled: false })
        .eq('id', companyId);
    }
    console.error(`📱 Push send failed for company ${companyId}:`, err.message);
    return { success: false, reason: err.message };
  }
}

// =====================
// START SERVER
// =====================
// Attached to the app function (not a separate module.exports shape) so the
// Vercel entrypoint contract below is unchanged — tests reach these via
// require('./server').getLeadsForUser / .updateLeadForUser / .distributeLead /
// .verifyStripeWebhookSignature / .handleStripeWebhookEvent.
app.getLeadsForUser = getLeadsForUser;
app.updateLeadForUser = updateLeadForUser;
app.distributeLead = distributeLead;
app.verifyStripeWebhookSignature = verifyStripeWebhookSignature;
app.handleStripeWebhookEvent = handleStripeWebhookEvent;

if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(port, () => {
    console.log(`🚀 ACConnx API running on port ${port}`);
    console.log(`💳 Stripe: ${stripe ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📧 Resend: ${resend ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📱 Twilio: ${twilio ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`🔔 Push: ${webpush ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`🗄️ Database: ✅ Supabase`);
  });
}
