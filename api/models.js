const mongoose = require('mongoose');

// Company Schema
const companySchema = new mongoose.Schema({
  company: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  password: { type: String, required: true }, // TODO: Hash in production
  postcode: { type: String, required: true },
  radius: { type: Number, default: 25 },
  credits: { type: Number, default: 5 }, // 5 free credits on signup
  hasPurchased: { type: Boolean, default: false },
  notifyEmail: { type: Boolean, default: true },
  notifySMS: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Lead Schema
const leadSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  customerPhone: String,
  postcode: { type: String, required: true },
  btu: Number,
  roomType: String,
  propertyType: String,
  notes: String,
  status: { type: String, default: 'new', enum: ['new', 'contacted', 'won', 'lost'] },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  originalLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  assignedAt: Date,
  statusUpdatedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

// Purchase Schema
const purchaseSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  package: { type: String, required: true },
  credits: { type: Number, required: true },
  amount: { type: String, required: true },
  isFirstPurchase: { type: Boolean, default: false },
  stripePaymentId: String,
  createdAt: { type: Date, default: Date.now }
});

// Prospect Schema (CRM)
const prospectSchema = new mongoose.Schema({
  company: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: String,
  city: String,
  postcode: String,
  status: { type: String, default: 'new', enum: ['new', 'contacted', 'interested', 'registered', 'customer'] },
  notes: String,
  lastContact: Date,
  createdAt: { type: Date, default: Date.now }
});

// Task Schema (CRM)
const taskSchema = new mongoose.Schema({
  prospectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prospect' },
  company: String,
  text: { type: String, required: true },
  dueDate: Date,
  completed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  Company: mongoose.model('Company', companySchema),
  Lead: mongoose.model('Lead', leadSchema),
  Purchase: mongoose.model('Purchase', purchaseSchema),
  Prospect: mongoose.model('Prospect', prospectSchema),
  Task: mongoose.model('Task', taskSchema)
};
