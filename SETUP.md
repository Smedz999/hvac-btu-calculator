# HVAC Lead Pro — Complete Setup Guide

## What You've Built

A **lead generation marketplace** with three components:

1. **Customer Calculator** (`index.html`) — Homeowners calculate BTU, submit for quotes
2. **Contractor Portal** (`company-portal.html`) — HVAC companies buy credits & receive leads
3. **Admin Dashboard** (`admin.html`) — You manage everything

---

## How It Works

### Customer Journey
1. Homeowner visits calculator, enters room details
2. Gets BTU estimate + recommended unit size
3. Fills in quote form (name, email, postcode)
4. System auto-matches with up to 3 local HVAC companies
5. Companies contact homeowner directly

### Contractor Journey
1. Visits `/company-portal.html`
2. Registers company + service area
3. Buys lead credits (Starter £25/5 leads, Pro £60/15, Business £100/30)
4. Receives email/SMS when matched lead arrives
5. Contacts customer, marks lead status (contacted/won/lost)

### Your Journey (Admin)
1. Visit `/admin.html`
2. See all leads, companies, purchases, revenue
3. Track conversion rates, top performers
4. No backend needed — everything runs in browser storage

---

## File Structure

```
hvac-calculator/
├── index.html              # Customer BTU calculator
├── company-portal.html     # Contractor signup/portal
├── admin.html              # Your admin dashboard
├── SETUP.md               # This file
└── .gitignore
```

---

## Deployment

All three files deploy to the same Vercel project:

```bash
# From hvac-calculator directory
vercel --prod
```

Access URLs:
- Calculator: `https://your-project.vercel.app/`
- Contractor Portal: `https://your-project.vercel.app/company-portal.html`
- Admin: `https://your-project.vercel.app/admin.html`

---

## Google Analytics 4

Replace `G-XXXXXXXXXX` in `index.html` with your real Measurement ID.

Tracked events:
- `calculate_btu` — User calculates BTU
- `lead_form_start` — User clicks "Get Free Quotes"
- `lead_form_submit` — Lead successfully submitted
- `unit_toggle` — Metric/Imperial switch
- `share_result` — Share button clicked

---

## Data Storage (Important!)

**Current setup uses browser localStorage.** This means:

✅ **Pros:**
- Zero backend costs
- Instant setup
- Works offline

⚠️ **Limitations:**
- Data is per-browser (not shared across devices)
- Data clears if user clears browser storage
- Not suitable for production scale

### To Add a Real Backend (Future)

When ready to scale, add:

1. **Supabase** (free tier) or **Firebase** for database
2. **Stripe** integration for real payments
3. **Email service** (SendGrid/Resend) for lead notifications
4. **SMS service** (Twilio) for instant alerts

The frontend is already structured for easy API integration.

---

## Pricing Strategy

| Package | Credits | Price | Per Lead | Best For |
|---------|---------|-------|----------|----------|
| Starter | 5 | £25 | £5.00 | Testing the platform |
| Professional | 15 | £60 | £4.00 | Regular contractors |
| Business | 30 | £100 | £3.33 | High-volume installers |

**Revenue example:** 10 Pro packages/month = £600/month

---

## Sourcing HVAC Companies

### Phase 1: Manual (Do Now)
1. Google "air conditioning installation [your city]"
2. Call 10-15 companies
3. Pitch: *"We send you qualified leads — homeowners who already know their BTU requirements. Pay per lead, no subscription."*
4. Send them to `/company-portal.html` to register

### Phase 2: Automated (Later)
- Scrape Google Maps for HVAC companies
- Bulk email with signup link
- Track who registers

---

## Next Steps

1. ✅ **Deploy these files** — `vercel --prod`
2. ✅ **Set up GA4** — Replace tracking ID
3. ✅ **Add Stripe** — For real payments (currently demo mode adds credits instantly)
4. ✅ **Recruit 3-5 HVAC companies** — Start with manual outreach
5. ✅ **Drive traffic** — SEO, local ads, social media
6. ✅ **Monitor admin dashboard** — Track leads, revenue, conversions

---

## Support

Questions? The system is fully self-contained. All data is in browser storage accessible via:

```javascript
// View all companies
JSON.parse(localStorage.getItem('hvac_companies'))

// View all leads
JSON.parse(localStorage.getItem('hvac_leads'))

// View all purchases
JSON.parse(localStorage.getItem('hvac_purchases'))
```

---

*Built for Lee's HVAC lead generation business.*
