const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Initialize services (will work when keys are added)
let stripe = null;
let resend = null;

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

// In-memory storage (replace with database for production)
const db = {
  companies: [],
  leads: [],
  purchases: []
};

app.use(cors());
app.use(express.json());

// =====================
// HEALTH CHECK
// =====================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    stripe: !!stripe,
    resend: !!resend,
    companies: db.companies.length,
    leads: db.leads.length,
    purchases: db.purchases.length
  });
});

// =====================
// COMPANIES
// =====================
app.post('/api/companies/register', async (req, res) => {
  const { company, name, email, phone, password, postcode, radius } = req.body;

  if (!company || !name || !email || !phone || !password || !postcode) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const existing = db.companies.find(c => c.email === email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const companyData = {
    id: 'comp_' + Date.now(),
    company,
    name,
    email,
    phone,
    password, // TODO: Hash in production
    postcode: postcode.toUpperCase(),
    radius: radius || 25,
    credits: 0,
    createdAt: new Date().toISOString(),
    notifyEmail: true,
    notifySMS: false
  };

  db.companies.push(companyData);

  // Send welcome email
  if (resend) {
    try {
      await resend.emails.send({
        from: 'ACConnx <onboarding@acconnx.com>',
        to: email,
        subject: 'Welcome to HVAC Lead Pro!',
        html: `<h1>Welcome ${name}!</h1><p>Your company ${company} is now registered. Buy credits to start receiving qualified leads.</p><p><a href="https://acconnx.com/company-portal.html">Login to your dashboard</a></p>`
      });
    } catch (e) {
      console.log('Failed to send welcome email:', e.message);
    }
  }

  res.json({ success: true, company: { ...companyData, password: undefined } });
});

app.post('/api/companies/login', (req, res) => {
  const { email, password } = req.body;
  const company = db.companies.find(c => c.email === email && c.password === password);

  if (!company) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({ success: true, company: { ...company, password: undefined } });
});

app.get('/api/companies', (req, res) => {
  res.json(db.companies.map(c => ({ ...c, password: undefined })));
});

app.put('/api/companies/:id', (req, res) => {
  const idx = db.companies.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Company not found' });

  db.companies[idx] = { ...db.companies[idx], ...req.body };
  res.json({ success: true, company: { ...db.companies[idx], password: undefined } });
});

// =====================
// LEADS
// =====================
app.post('/api/leads', async (req, res) => {
  const { customerName, customerEmail, customerPhone, postcode, btu, roomType, propertyType, notes } = req.body;

  const lead = {
    id: 'lead_' + Date.now(),
    customerName,
    customerEmail,
    customerPhone,
    postcode: postcode?.toUpperCase(),
    btu,
    roomType,
    propertyType,
    notes,
    status: 'new',
    createdAt: new Date().toISOString()
  };

  db.leads.push(lead);

  // Auto-distribute to matching companies
  const distributed = await distributeLead(lead);

  res.json({ success: true, lead, distributed: distributed || [] });
});

app.get('/api/leads', (req, res) => {
  const { companyId } = req.query;
  let leads = db.leads;
  if (companyId) {
    leads = leads.filter(l => l.companyId === companyId);
  }
  res.json(leads);
});

app.put('/api/leads/:id', (req, res) => {
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });

  db.leads[idx] = { ...db.leads[idx], ...req.body, statusUpdatedAt: new Date().toISOString() };
  res.json({ success: true, lead: db.leads[idx] });
});

// =====================
// STRIPE PAYMENTS
// =====================
app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured. Add STRIPE_SECRET_KEY to environment variables.' });
  }

  const { packageId, companyId } = req.body;
  const packages = {
    starter: { amount: 2500, credits: 5 },
    professional: { amount: 6000, credits: 15 },
    business: { amount: 10000, credits: 30 }
  };

  const pkg = packages[packageId];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: pkg.amount,
      currency: 'gbp',
      metadata: { packageId, companyId, credits: pkg.credits }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/confirm-payment', async (req, res) => {
  const { companyId, packageId, credits, amount } = req.body;

  const company = db.companies.find(c => c.id === companyId);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  company.credits = (company.credits || 0) + credits;

  const purchase = {
    id: 'pur_' + Date.now(),
    companyId,
    package: packageId,
    credits,
    amount: '£' + (amount / 100),
    createdAt: new Date().toISOString()
  };

  db.purchases.push(purchase);

  // Send receipt email
  if (resend) {
    try {
      await resend.emails.send({
        from: 'ACConnx <receipts@acconnx.com>',
        to: company.email,
        subject: 'Payment Confirmation - HVAC Lead Pro',
        html: `<h1>Thank you for your purchase!</h1><p>You bought ${credits} credits for £${amount / 100}.</p><p>Your new balance: ${company.credits} credits</p><p><a href="https://acconnx.com/company-portal.html">View Dashboard</a></p>`
      });
    } catch (e) {
      console.log('Failed to send receipt:', e.message);
    }
  }

  res.json({ success: true, company: { ...company, password: undefined }, purchase });
});

// =====================
// ADMIN STATS
// =====================
app.get('/api/admin/stats', (req, res) => {
  const totalRevenue = db.purchases.reduce((sum, p) => {
    const amount = parseInt(p.amount?.replace(/[^0-9]/g, '') || 0);
    return sum + amount;
  }, 0);

  const distributedLeads = db.leads.filter(l => l.companyId);
  const originalLeads = db.leads.filter(l => !l.companyId);
  const wonLeads = db.leads.filter(l => l.status === 'won');

  res.json({
    totalRevenue,
    totalCompanies: db.companies.length,
    totalLeads: originalLeads.length,
    distributedLeads: distributedLeads.length,
    totalCredits: db.purchases.reduce((sum, p) => sum + (p.credits || 0), 0),
    conversionRate: distributedLeads.length > 0 ? Math.round((wonLeads.length / distributedLeads.length) * 100) : 0,
    undistributed: originalLeads.filter(l => !distributedLeads.some(dl => dl.originalLeadId === l.id)).length
  });
});

// =====================
// LEAD DISTRIBUTION
// =====================
async function distributeLead(lead) {
  const leadPrefix = lead.postcode?.split(' ')[0];
  if (!leadPrefix) return [];

  const eligible = db.companies.filter(comp => {
    if ((comp.credits || 0) <= 0) return false;
    const compPrefix = comp.postcode?.split(' ')[0];
    return compPrefix === leadPrefix || comp.postcode?.startsWith(leadPrefix.substring(0, 2));
  });

  eligible.sort((a, b) => (b.credits || 0) - (a.credits || 0));
  const selected = eligible.slice(0, 3);

  for (const company of selected) {
    company.credits = (company.credits || 0) - 1;

    const companyLead = {
      ...lead,
      id: lead.id + '_comp' + company.id,
      originalLeadId: lead.id,
      companyId: company.id,
      status: 'new',
      assignedAt: new Date().toISOString()
    };

    db.leads.push(companyLead);

    // Send email notification
    if (resend && company.notifyEmail !== false) {
      try {
        await resend.emails.send({
          from: 'ACConnx <leads@acconnx.com>',
          to: company.email,
          subject: '🔥 New Lead: ' + lead.customerName + ' - ' + lead.postcode,
          html: `<h1>New Lead Alert!</h1>
            <p><strong>Customer:</strong> ${lead.customerName}</p>
            <p><strong>Email:</strong> ${lead.customerEmail}</p>
            <p><strong>Phone:</strong> ${lead.customerPhone || 'Not provided'}</p>
            <p><strong>Postcode:</strong> ${lead.postcode}</p>
            <p><strong>BTU Required:</strong> ${lead.btu?.toLocaleString() || 'Not calculated'}</p>
            <p><strong>Room Type:</strong> ${lead.roomType || 'Not specified'}</p>
            <p><a href="https://acconnx.com/company-portal.html">View in Dashboard</a></p>
            <p><em>Contact within 15 minutes for best results!</em></p>`
        });
      } catch (e) {
        console.log('Failed to send lead notification:', e.message);
      }
    }
  }

  return selected.map(c => c.company);
}

// =====================
// START SERVER
// =====================
app.listen(port, () => {
  console.log(`🚀 ACConnx API running on port ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
  console.log(`💳 Stripe: ${stripe ? '✅ Connected' : '⚠️ Not configured (add STRIPE_SECRET_KEY)'}`);
  console.log(`📧 Resend: ${resend ? '✅ Connected' : '⚠️ Not configured (add RESEND_API_KEY)'}`);
});
