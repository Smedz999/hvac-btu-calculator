# HVAC Lead Pro — Automated Email Sender

## What This Does

Automatically sends personalized recruitment emails to HVAC companies.

## Setup

### 1. Install Dependencies
```bash
cd email-sender
npm install
```

### 2. Add Resend API Key
```bash
cp .env.example .env
# Edit .env and add your RESEND_API_KEY
```

Get your API key from [resend.com](https://resend.com) (free tier: 100 emails/day)

### 3. Add Target Companies

Edit `companies.csv`:
```csv
name,email,city,postcode
Cool Air Ltd,info@coolair.co.uk,Manchester,M1
Arctic Cooling,sales@arcticcooling.com,Birmingham,B1
```

**To find HVAC company emails:**
1. Google "air conditioning installation [city]"
2. Visit company websites
3. Look for "Contact" or "Get a Quote" pages
4. Check email format (usually info@, sales@, or hello@)

### 4. Send Emails

```bash
# Send recruitment emails
node sender.js

# Send follow-up emails (after 3-4 days)
node sender.js --follow-up
```

## How It Works

1. **Loads companies** from `companies.csv`
2. **Loads email template** from `../email-templates/contractor-recruitment.html`
3. **Personalizes** each email with company name, city, etc.
4. **Sends via Resend** with 3-second delay between emails
5. **Saves results** to `email-results.json`

## Email Templates

Located in `../email-templates/`:

| Template | Purpose |
|----------|---------|
| `contractor-recruitment.html` | Initial outreach to HVAC companies |
| `follow-up.html` | Follow-up after 3-4 days |
| `lead-notification.html` | Sent to contractors when new lead arrives |
| `welcome-contractor.html` | Welcome email after registration |

## Without API Key (Demo Mode)

If you don't have a Resend API key yet, the sender will:
- ✅ Load and compile all templates
- ✅ Show exactly what would be sent
- ✅ Log to console instead of sending
- ✅ Save results to `email-results.json`

This lets you preview everything before getting API keys.

## Rate Limits

- **Resend free tier:** 100 emails/day
- **Delay between sends:** 3 seconds (configurable)
- **Recommended batch size:** 20-30 companies/day

## Tips

1. **Personalize the CSV** — Add real company names and emails
2. **Test first** — Send to your own email to check formatting
3. **Track responses** — Update your spreadsheet when companies reply
4. **Follow up** — Non-responders get a follow-up after 3-4 days
5. **Don't spam** — Only contact companies in your service area

## Example Output

```
🔥 HVAC Lead Pro — Email Sender

📁 Loading companies from companies.csv
✅ Loaded 5 companies from CSV

📋 Companies to contact:
   1. Cool Air Ltd (info@coolair.co.uk) - Manchester
   2. Arctic Cooling (sales@arcticcooling.com) - Birmingham
   ...

🚀 Starting batch send: recruitment
📊 Total companies: 5
⏱️  Delay between emails: 3000ms

[1/5] Processing: Cool Air Ltd
✅ Email sent to Cool Air Ltd (info@coolair.co.uk)
   Waiting 3000ms before next email...

[2/5] Processing: Arctic Cooling
✅ Email sent to Arctic Cooling (sales@arcticcooling.com)
   ...

✅ Batch complete! Sent 5 emails
💾 Results saved to: email-results.json
```

## Next Steps

1. ✅ Send recruitment emails
2. ⏳ Wait 3-4 days
3. 📧 Send follow-ups to non-responders
4. 📞 Call interested companies
5. 🤝 Get them registered on your platform

---

*Remember: Quality over quantity. 10 personalized emails beat 100 generic ones.*
