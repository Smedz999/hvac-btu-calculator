const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const { Company, Lead, Purchase } = require('./models');

const app = express();
const port = process.env.PORT || 3001;

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

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/acconnx';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

app.use(cors());
app.use(express.json());

// =====================
// HEALTH CHECK
// =====================
app.get('/api/health', async (req, res) => {
  try {
    const companies = await Company.countDocuments();
    const leads = await Lead.countDocuments();
    const purchases = await Purchase.countDocuments();
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      stripe: !!stripe,
      resend: !!resend,
      twilio: !!twilio,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      companies,
      leads,
      purchases
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
    const { company, name, email, phone, password, postcode, radius } = req.body;

    if (!company || !name || !email || !phone || !password || !postcode) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await Company.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password before saving
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const companyData = new Company({
      company,
      name,
      email,
      phone,
      password: hashedPassword,
      postcode: postcode.toUpperCase(),
      radius: radius || 25,
      credits: 5, // 5 free credits
      hasPurchased: false,
      notifyEmail: true,
      notifySMS: false
    });

    await companyData.save();

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

    const companyObj = companyData.toObject();
    delete companyObj.password;
    res.json({ success: true, company: companyObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const company = await Company.findOne({ email });

    if (!company) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Compare hashed password
    const isMatch = await bcrypt.compare(password, company.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const companyObj = company.toObject();
    delete companyObj.password;
    res.json({ success: true, company: companyObj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/companies', async (req, res) => {
  try {
    const companies = await Company.find().select('-password');
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/companies/:id', async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      { ...req.body },
      { new: true }
    ).select('-password');
    
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

    const lead = new Lead({
      customerName,
      customerEmail,
      customerPhone,
      postcode: postcode?.toUpperCase(),
      btu,
      roomType,
      propertyType,
      notes,
      status: 'new'
    });

    await lead.save();

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
    let query = {};
    if (companyId) {
      query.companyId = companyId;
    }
    const leads = await Lead.find(query).sort({ createdAt: -1 });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { ...req.body, statusUpdatedAt: new Date() },
      { new: true }
    );
    
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

    const company = await Company.findById(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    company.credits = (company.credits || 0) + credits;
    company.hasPurchased = true;
    await company.save();

    const purchase = new Purchase({
      companyId,
      package: packageId,
      credits,
      amount: '£' + (amount / 100).toFixed(2),
      isFirstPurchase: isFirstPurchase || false
    });

    await purchase.save();

    // Send receipt email
    if (resend) {
      try {
        await resend.emails.send({
          from: 'ACConnx <receipts@acconnx.com>',
          to: company.email,
          subject: 'Payment Confirmation - ACConnx',
          html: `<h1>Thank you for your purchase!</h1><p>You bought ${credits} credits for £${(amount / 100).toFixed(2)}.</p><p>Your new balance: ${company.credits} credits</p><p><a href="https://acconnx.com/company-portal.html">View Dashboard</a></p>`
        });
      } catch (e) {
        console.log('Failed to send receipt:', e.message);
      }
    }

    const companyObj = company.toObject();
    delete companyObj.password;
    res.json({ success: true, company: companyObj, purchase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================
// ADMIN STATS
// =====================
app.get('/api/admin/stats', async (req, res) => {
  try {
    const purchases = await Purchase.find();
    const totalRevenue = purchases.reduce((sum, p) => {
      const amount = parseFloat(p.amount?.replace(/[^0-9.]/g, '') || 0);
      return sum + amount;
    }, 0);

    const totalCompanies = await Company.countDocuments();
    const totalLeads = await Lead.countDocuments({ companyId: { $exists: false } });
    const distributedLeads = await Lead.countDocuments({ companyId: { $exists: true } });
    const wonLeads = await Lead.countDocuments({ status: 'won' });

    res.json({
      totalRevenue: totalRevenue.toFixed(2),
      totalCompanies,
      totalLeads,
      distributedLeads,
      totalCredits: purchases.reduce((sum, p) => sum + (p.credits || 0), 0),
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
    const eligible = await Company.find({
      credits: { $gt: 0 },
      $or: [
        { postcode: { $regex: `^${leadPrefix}`, $options: 'i' } },
        { postcode: { $regex: `^${leadPrefix.substring(0, 2)}`, $options: 'i' } }
      ]
    }).sort({ credits: -1 }).limit(3);

    for (const company of eligible) {
      company.credits = (company.credits || 0) - 1;
      await company.save();

      const companyLead = new Lead({
        ...lead.toObject(),
        _id: undefined,
        originalLeadId: lead._id,
        companyId: company._id,
        status: 'new',
        assignedAt: new Date()
      });

      await companyLead.save();

      // Send SMS notification
      if (twilio && company.notifySMS === true && company.phone) {
        try {
          await twilio.messages.create({
            body: `🔥 ACConnx Lead: ${lead.customerName} in ${lead.postcode}. ${lead.btu ? lead.btu.toLocaleString() + ' BTU' : 'BTU TBD'}. Login: acconnx.com/company-portal.html`,
            to: company.phone,
            from: process.env.TWILIO_PHONE_NUMBER || 'ACConnx'
          });
        } catch (e) {
          console.log('Failed to send SMS:', e.message);
        }
      }

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

    return eligible.map(c => c.company);
  } catch (err) {
    console.error('Lead distribution error:', err);
    return [];
  }
}

// =====================
// START SERVER
// =====================
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`🚀 ACConnx API running on port ${port}`);
    console.log(`📊 Health check: http://localhost:${port}/api/health`);
    console.log(`💳 Stripe: ${stripe ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📧 Resend: ${resend ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`📱 Twilio: ${twilio ? '✅ Connected' : '⚠️ Not configured'}`);
    console.log(`🗄️  MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⚠️ Not configured'}`);
  });
}

module.exports = app;
