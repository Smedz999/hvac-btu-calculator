# Twilio SMS Setup Guide for ACConnx

## What You Get

- SMS notifications to contractors when new leads arrive
- ~£0.04 per SMS (3 contractors = £0.12 per lead)
- Contractors get instant alerts = faster response = higher conversion

## Setup (10 minutes)

### 1. Create Twilio Account
1. Go to https://www.twilio.com/try-twilio
2. Sign up (free trial includes £12 credit)
3. Verify your email and phone number

### 2. Get a Phone Number
1. In Twilio Console, go to **Phone Numbers** → **Buy a number**
2. Choose **United Kingdom**
3. Select a number with **SMS** capability
4. Cost: ~£1/month + usage

### 3. Get Your Credentials
1. In Twilio Console dashboard, find:
   - **Account SID** (starts with AC...)
   - **Auth Token** (click to reveal)
2. Copy both

### 4. Add to Vercel
Go to your Vercel project → Settings → Environment Variables:

| Name | Value |
|------|-------|
| `TWILIO_ACCOUNT_SID` | Your Account SID |
| `TWILIO_AUTH_TOKEN` | Your Auth Token |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (e.g., +447...) |

### 5. Redeploy
Vercel will auto-deploy when you push, or manually trigger a redeploy.

## How It Works

When a new lead comes in:

1. System finds 3 contractors with credits in the postcode area
2. Sends email to all 3 (if they have email notifications on)
3. Sends SMS to contractors who:
   - Have SMS notifications enabled (`notifySMS: true`)
   - Have a phone number on file
   - Have credits remaining

**SMS Message:**
```
🔥 ACConnx Lead: John Smith in SW1A. 12,000 BTU. Login: acconnx.com/company-portal.html
```

## Cost Breakdown

| Volume | SMS Cost | Email Cost | Total |
|--------|----------|------------|-------|
| 100 leads/month | £12 | £0 | £12 |
| 500 leads/month | £60 | £0 | £60 |
| 1000 leads/month | £120 | £0 | £120 |

*Assumes 3 contractors per lead, £0.04 per SMS*

## Testing

1. Set up a test contractor account with your real phone number
2. Enable SMS notifications in profile
3. Submit a test lead from the calculator
4. You should receive an SMS within seconds

## Need Help?

If SMS isn't sending:
1. Check Twilio console for error logs
2. Verify phone number format (+44...)
3. Check contractor has `notifySMS: true` in database
4. Check Twilio balance isn't £0

## Alternative: Cheaper SMS

If Twilio is too expensive at scale:
- **Vonage**: ~£0.03 per SMS
- **Textlocal**: ~£0.02 per SMS (UK-focused)

Both work similarly — just swap the API calls.
