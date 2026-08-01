# HVAC Lead Pro — Deployment Guide

## What's Built

✅ **Customer Calculator** — BTU calculator with lead capture
✅ **Contractor Portal** — Registration, credit purchases, lead management
✅ **Contractor Recruitment** — Landing page to attract HVAC companies
✅ **Admin Dashboard** — Track everything
✅ **Backend API** — Node.js/Express server
✅ **Stripe Integration** — Ready for payments
✅ **Email Notifications** — Ready for Resend
✅ **Outreach Templates** — Email, phone, SMS scripts
✅ **SEO Strategy** — Content plan for organic traffic

---

## Step 1: Deploy Backend to Railway (Free)

### 1.1 Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select `Smedz999/hvac-btu-calculator`

### 1.2 Configure Build
Railway will auto-detect the Node.js app. Set the start command:
```
node api/server.js
```

### 1.3 Add Environment Variables
In Railway dashboard → Variables:
```
STRIPE_SECRET_KEY=sk_live_... (add when ready)
RESEND_API_KEY=re_... (add when ready)
PORT=3001
```

### 1.4 Deploy
Click "Deploy". Railway gives you a URL like:
```
https://hvac-lead-pro-api.up.railway.app
```

### 1.5 Update Frontend
Replace `https://hvac-lead-pro-api.up.railway.app` in:
- `index.html` (line ~727)
- `company-portal.html` (line ~618)

---

## Step 2: Add Stripe (When Ready)

### 2.1 Create Stripe Account
1. Go to [stripe.com](https://stripe.com)
2. Complete onboarding
3. Get API keys from Dashboard → Developers → API keys

### 2.2 Add Keys
**Backend (Railway):**
```
STRIPE_SECRET_KEY=sk_live_...
```

**Frontend (company-portal.html):**
```javascript
const STRIPE_KEY = 'pk_live_...';
```

### 2.3 Test Payment
1. Buy Starter package in contractor portal
2. Use Stripe test card: `4242 4242 4242 4242`
3. Any future date, any CVC, any ZIP

---

## Step 3: Add Email (Resend)

### 3.1 Create Resend Account
1. Go to [resend.com](https://resend.com)
2. Sign up
3. Get API key

### 3.2 Add Key
**Backend (Railway):**
```
RESEND_API_KEY=re_...
```

### 3.3 Verify Domain (Optional)
For production, verify your domain in Resend:
- Add DNS records
- Send from `leads@yourdomain.com`

---

## Step 4: Recruit Contractors

### 4.1 Use Outreach Templates
See `OUTREACH.md` for:
- Email templates
- Phone scripts
- SMS templates
- Facebook/LinkedIn messages

### 4.2 Find Companies
1. Google Maps: "air conditioning installation [city]"
2. Yell.com
3. Checkatrade (they're already paying for leads!)
4. Facebook Groups

### 4.3 Track Progress
Use the spreadsheet template in `OUTREACH.md`

**Goal:** 5 registered contractors in Week 1

---

## Step 5: Drive Homeowner Traffic

### 5.1 SEO (Free)
See `seo-content.md` for:
- Blog post ideas
- Landing page templates
- Keyword targets
- Content calendar

### 5.2 Google Business Profile
Create profile: "HVAC Lead Pro"
- Category: HVAC Consultant
- Service areas: Your target cities
- Post weekly updates

### 5.3 Paid Ads (When Ready)
**Google Ads:**
- Keywords: "btu calculator", "ac installation [city]"
- Budget: £10-20/day
- Landing page: Calculator

**Facebook Ads:**
- Target: Homeowners 30-65
- Interest: Home improvement
- Budget: £5-10/day

---

## URLs Summary

| Component | URL |
|-----------|-----|
| Customer Calculator | https://hvac-calculator-opal.vercel.app |
| Contractor Recruitment | https://hvac-calculator-opal.vercel.app/for-contractors.html |
| Contractor Portal | https://hvac-calculator-opal.vercel.app/company-portal.html |
| Admin Dashboard | https://hvac-calculator-opal.vercel.app/admin.html |
| Backend API | https://hvac-lead-pro-api.up.railway.app |

---

## Checklist

- [ ] Deploy backend to Railway
- [ ] Add Stripe keys (when ready)
- [ ] Add Resend key (when ready)
- [ ] Update API URL in frontend
- [ ] Recruit 5 contractors
- [ ] Publish first blog post
- [ ] Create Google Business Profile
- [ ] Test complete flow (calculator → lead → contractor notification)
- [ ] Launch paid ads (when ready)

---

## Support

Questions? Check:
- `SETUP.md` — Technical setup
- `OUTREACH.md` — Contractor recruitment
- `seo-content.md` — Marketing strategy

---

*Built for Lee's HVAC lead generation business.*
