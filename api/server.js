const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

// Supabase connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

app.use(cors());
app.use(express.json());

// =====================
// HEALTH CHECK
// =====================
app.get('/api/health', async (req, res) => {
  try {
    const { count: companies } = await supabase.from('companies').select('*', { count: 'exact', head: true });
    const { count: leads } = await supabase.from('leads').select('*', { count: 'exact', head: true });
    const { count: purchases } = await supabase.from('purchases').select('*', { count: 'exact', head: true });

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
    res.status(500).json({ error: err.message });
  }
});

// =====================
// COMPANIES
// =====================
app.post('/api/companies/register', async (req, res) => {
  try {
    const { company, name, email, phone, password, postcode, radius, fgas_number } = req.body;

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

    const { data: companyData, error } = await supabase
      .from('companies')
      .insert({
        company,
        name,
        email,
        phone,
        password: hashedPassword,
        postcode: postcode.toUpperCase(),
        radius: radius || 25,
        credits: 5,
        fgas_number: fgas_number || null
      })
      .select()
      .single();

    if (error) throw error;

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
    res.json({ success: true, company: companyData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/login', async (req, res) => {
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
    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companies', async (req, res) => {
  try {
    const { data: companies, error } = await supabase
      .from('companies')
      .select('id, company, name, email, phone, postcode, radius, credits, created_at, updated_at');

    if (error) throw error;
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/companies/:id', async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.id;
    delete updates.password;

    const { data: company, error } = await supabase
      .from('companies')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, company, name, email, phone, postcode, radius, credits, created_at, updated_at')
      .single();

    if (error) throw error;
    if (!company) return res.status(404).json({ error: 'Company not found' });

    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// LEADS
// =====================
app.post('/api/leads', async (req, res) => {
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

app.get('/api/leads', async (req, res) => {
  try {
    const { companyId } = req.query;
    let query = supabase.from('leads').select('*').order('created_at', { ascending: false });

    if (companyId) {
      query = query.eq('assigned_to', companyId);
    }

    const { data: leads, error } = await query;
    if (error) throw error;
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    delete updates.id;

    const { data: lead, error } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// STRIPE PAYMENTS
// =====================
const CREDIT_PACKAGES = {
  starter: { name: 'Starter', credits: 5, price: 4999, firstPrice: 3999 },
  professional: { name: 'Professional', credits: 15, price: 12999, firstPrice: 10399 },
  business: { name: 'Business', credits: 30, price: 19999, firstPrice: 15999 }
};

app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  try {
    const { packageId, companyId, isFirstPurchase } = req.body;
    const pkg = CREDIT_PACKAGES[packageId];

    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    const amount = isFirstPurchase ? pkg.firstPrice : pkg.price;

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'gbp',
      metadata: { packageId, companyId, credits: pkg.credits, isFirstPurchase: isFirstPurchase ? 'true' : 'false' }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/confirm-payment', async (req, res) => {
  try {
    const { companyId, packageId, credits, amount, isFirstPurchase } = req.body;

    // Get current company
    const { data: company, error: fetchError } = await supabase
      .from('companies')
      .select('*')
      .eq('id', companyId)
      .single();

    if (fetchError || !company) return res.status(404).json({ error: 'Company not found' });

    // Update credits
    const newCredits = (company.credits || 0) + credits;
    const { data: updatedCompany, error: updateError } = await supabase
      .from('companies')
      .update({ credits: newCredits, updated_at: new Date().toISOString() })
      .eq('id', companyId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Record purchase
    const { data: purchase, error: purchaseError } = await supabase
      .from('purchases')
      .insert({
        company_id: companyId,
        package_name: packageId,
        credits,
        amount: amount / 100,
        status: 'completed'
      })
      .select()
      .single();

    if (purchaseError) throw purchaseError;

    // Send receipt email
    if (resend) {
      try {
        await resend.emails.send({
          from: 'ACConnx <receipts@acconnx.com>',
          to: company.email,
          subject: 'Payment Confirmation - ACConnx',
          html: `<h1>Thank you for your purchase!</h1><p>You bought ${credits} credits for £${(amount / 100).toFixed(2)}.</p><p>Your new balance: ${newCredits} credits</p><p><a href="https://acconnx.com/company-portal.html">View Dashboard</a></p>`
        });
      } catch (e) {
        console.log('Failed to send receipt:', e.message);
      }
    }

    delete updatedCompany.password;
    res.json({ success: true, company: updatedCompany, purchase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// ADMIN STATS
// =====================
app.get('/api/admin/stats', async (req, res) => {
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
async function distributeLead(lead) {
  try {
    const leadPrefix = lead.postcode?.split(' ')[0];
    if (!leadPrefix) return [];

    // Find eligible companies (have credits, matching postcode area)
    const { data: eligible, error } = await supabase
      .from('companies')
      .select('*')
      .gt('credits', 0)
      .or(`postcode.ilike.${leadPrefix}%,postcode.ilike.${leadPrefix.substring(0, 2)}%`)
      .order('credits', { ascending: false })
      .limit(3);

    if (error) throw error;
    if (!eligible || eligible.length === 0) return [];

    for (const company of eligible) {
      // Deduct credit
      await supabase
        .from('companies')
        .update({ credits: company.credits - 1, updated_at: new Date().toISOString() })
        .eq('id', company.id);

      // Create assigned lead copy
      await supabase
        .from('leads')
        .insert({
          customer_name: lead.customer_name,
          customer_email: lead.customer_email,
          customer_phone: lead.customer_phone,
          postcode: lead.postcode,
          btu: lead.btu,
          room_type: lead.room_type,
          property_type: lead.property_type,
          status: 'new',
          assigned_to: company.id
        });

      // Send email notification
      if (resend) {
        try {
          await resend.emails.send({
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
    }

    return eligible.map(c => c.company);
  } catch (err) {
    console.error('Lead distribution error:', err);
    return [];
  }
}

// =====================
// CRM — PROSPECTS
// =====================
app.get('/api/prospects', async (req, res) => {
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

app.post('/api/prospects', async (req, res) => {
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

app.put('/api/prospects/:id', async (req, res) => {
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

app.delete('/api/prospects/:id', async (req, res) => {
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
app.get('/api/tasks', async (req, res) => {
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

app.post('/api/tasks', async (req, res) => {
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

app.put('/api/tasks/:id', async (req, res) => {
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

app.delete('/api/tasks/:id', async (req, res) => {
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
// START SERVER
// =====================
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(port, () => {
    console.log(`🚀 ACConnx API running on port ${port}`);
    console.log(`💳 Stripe: ${stripe ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📧 Resend: ${resend ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📱 Twilio: ${twilio ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`🗄️ Database: ✅ Supabase`);
  });
}
