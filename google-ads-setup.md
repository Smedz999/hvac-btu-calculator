# Google Ads Setup Guide for HVAC Lead Pro

## Campaign Structure

### Campaign 1: BTU Calculator (Primary)
**Goal:** Drive traffic to calculator, capture leads

**Settings:**
- Campaign Type: Search
- Budget: £10-15/day
- Locations: UK (start with major cities)
- Language: English
- Bid Strategy: Maximize Conversions (after tracking setup)

**Ad Groups:**

#### Ad Group 1: BTU Calculator
**Keywords:**
- [btu calculator] — Exact match
- [air conditioner btu calculator] — Exact match
- [ac btu calculator] — Exact match
- [room size btu calculator] — Exact match
- [hvac load calculator] — Exact match
- btu calculator — Phrase match
- air conditioning calculator — Phrase match
- how to calculate btu — Phrase match
- btu calculator for room — Broad match modified

**Ads:**

**Ad 1:**
- Headline 1: Free HVAC BTU Calculator
- Headline 2: Calculate AC Size in 30 Seconds
- Headline 3: Get 3 Free Quotes Instantly
- Description: Enter room dimensions & get accurate BTU estimate. Compare quotes from local installers. Free tool.
- URL: hvac-calculator-opal.vercel.app

**Ad 2:**
- Headline 1: Air Conditioner Sizing Tool
- Headline 2: Find Your Perfect AC Unit Size
- Headline 3: Free BTU Calculator UK
- Description: Professional BTU calculator for homes & offices. Get matched with certified local installers.
- URL: hvac-calculator-opal.vercel.app

---

### Campaign 2: AC Installation (High Intent)
**Goal:** Capture high-intent buyers ready to install

**Settings:**
- Campaign Type: Search
- Budget: £15-25/day
- Locations: UK major cities
- Bid Strategy: Maximize Conversions

**Ad Groups:**

#### Ad Group 1: AC Installation Quotes
**Keywords:**
- [air conditioning installation] — Exact
- [ac installation cost] — Exact
- [install air conditioning] — Exact
- [domestic air conditioning installation] — Exact
- air conditioning installation near me — Phrase
- ac installer [city] — Phrase
- home air conditioning installation — Phrase
- split air conditioning installation — Phrase

**Ads:**

**Ad 1:**
- Headline 1: AC Installation Quotes
- Headline 2: Get 3 Free Quotes Today
- Headline 3: F-Gas Certified Installers
- Description: Compare quotes from local AC installers. Free, no-obligation service. All installers certified.
- URL: hvac-calculator-opal.vercel.app

**Ad 2:**
- Headline 1: Air Con Installation Cost
- Headline 2: £2,500 Average in UK
- Headline 3: Get Your Free Quote
- Description: Calculate BTU needs first, then get 3 quotes. Compare prices & reviews. Free service.
- URL: hvac-calculator-opal.vercel.app

---

### Campaign 3: Local (City-Specific)
**Goal:** Target specific cities with high-value leads

**Settings:**
- Campaign Type: Search
- Budget: £5-10/day per city
- Locations: Individual cities

**Cities to Target (in order):**
1. London
2. Manchester
3. Birmingham
4. Bristol
5. Leeds
6. Glasgow
7. Edinburgh

**Keywords per city:**
- air conditioning installation [city]
- ac installer [city]
- air con [city]
- domestic air conditioning [city]
- btu calculator [city]

**Ads:**

**Ad for London:**
- Headline 1: AC Installation London
- Headline 2: Get 3 Free Quotes Today
- Headline 3: All London Areas Covered
- Description: F-Gas certified installers across London. Free BTU calculator + instant quotes. No obligation.
- URL: hvac-calculator-opal.vercel.app/ac-installation-london.html

---

## Conversion Tracking

### Set Up Google Ads Conversion Tracking

1. **Go to:** Google Ads → Tools & Settings → Conversions
2. **Click:** New Conversion Action → Website
3. **Enter:** Your domain (hvac-calculator-opal.vercel.app)
4. **Create:** Two conversion actions:

#### Conversion 1: Lead Form Submit
- Name: Lead Form Submit
- Category: Submit lead form
- Value: £15 (average lead value)
- Count: One

#### Conversion 2: BTU Calculation
- Name: BTU Calculation
- Category: Other
- Value: £5 (lower intent)
- Count: One

### Install Tracking Code

Add this to your `index.html` before closing `</body>`:

```html
<!-- Google Ads Conversion Tracking -->
<script>
function gtag_report_conversion(url) {
  var callback = function () {
    if (typeof(url) != 'undefined') {
      window.location = url;
    }
  };
  gtag('event', 'conversion', {
      'send_to': 'AW-XXXXXXXXX/XXXXXXXX',
      'value': 15.0,
      'currency': 'GBP',
      'event_callback': callback
  });
  return false;
}

// Track BTU calculation
document.getElementById('btuForm').addEventListener('submit', function() {
  gtag('event', 'conversion', {
    'send_to': 'AW-XXXXXXXXX/XXXXXXXX',
    'value': 5.0,
    'currency': 'GBP'
  });
});

// Track lead form submit
document.getElementById('leadForm').addEventListener('submit', function() {
  gtag('event', 'conversion', {
    'send_to': 'AW-XXXXXXXXX/XXXXXXXX',
    'value': 15.0,
    'currency': 'GBP'
  });
});
</script>
```

Replace `AW-XXXXXXXXX/XXXXXXXX` with your actual Google Ads conversion ID.

---

## Negative Keywords (Add These)

Add to all campaigns to avoid wasted spend:

```
-free (unless offering free quotes)
-DIY
-repair
-service
-maintenance
-second hand
-used
-cheap
-hire
-rental
-job
-career
-salary
-training
-course
```

---

## Budget Recommendations

### Phase 1: Testing (Week 1-2)
- BTU Calculator campaign: £10/day
- AC Installation campaign: £15/day
- Total: £25/day = £175/week

### Phase 2: Scaling (Week 3-4)
- BTU Calculator: £15/day
- AC Installation: £25/day
- Local campaigns: £5/day x 3 cities = £15/day
- Total: £55/day = £385/week

### Phase 3: Full Scale (Month 2+)
- BTU Calculator: £20/day
- AC Installation: £40/day
- Local campaigns: £5/day x 7 cities = £35/day
- Total: £95/day = £665/week

**Expected Results:**
- Cost per lead: £5-10
- Leads per day: 5-15
- Monthly leads: 150-450
- Revenue at £4/lead: £600-1,800/month (just from lead sales)

---

## Ad Extensions

### Sitelink Extensions
- Free BTU Calculator
- AC Installation Cost Guide
- Get 3 Free Quotes
- Contractor Login

### Callout Extensions
- Free Tool
- F-Gas Certified
- Up to 3 Quotes
- UK Wide Coverage
- No Obligation

### Structured Snippets
- **Services:** Installation, Split Systems, Multi-Split, Ducted
- **Brands:** Mitsubishi, Daikin, LG, Samsung
- **Areas:** London, Manchester, Birmingham, Bristol

---

## Landing Page Strategy

| Campaign | Landing Page |
|----------|-------------|
| BTU Calculator | /index.html |
| AC Installation | /index.html (with lead form visible) |
| Local - London | /ac-installation-london.html |
| Local - Manchester | /ac-installation-manchester.html |
| Local - Birmingham | /ac-installation-birmingham.html |

---

## Optimization Checklist

### Week 1
- [ ] Campaigns live
- [ ] Conversion tracking working
- [ ] Search terms report checked daily
- [ ] Negative keywords added

### Week 2
- [ ] Pause low-performing keywords
- [ ] Test new ad copy
- [ ] Adjust bids based on conversion data
- [ ] Add new negative keywords

### Week 3
- [ ] Scale winning campaigns
- [ ] Add new ad groups
- [ ] Test landing pages
- [ ] Review quality scores

### Week 4
- [ ] Monthly performance review
- [ ] Budget reallocation
- [ ] New city campaigns
- [ ] Remarketing setup

---

## Remarketing (Phase 2)

### Audience Lists
1. **BTU Calculator Users** (visited calculator)
2. **Lead Form Starters** (clicked but didn't submit)
3. **Quote Requesters** (submitted lead form)

### Remarketing Ads
**Ad 1:**
- Headline: Still Need AC Installation?
- Description: Get your free quotes today. 3 certified installers waiting.

**Ad 2:**
- Headline: Complete Your Quote Request
- Description: You started calculating BTU. Finish and get 3 free quotes.

---

## Key Metrics to Track

| Metric | Target |
|--------|--------|
| CTR | >5% |
| Cost per click | <£2 |
| Conversion rate | >10% |
| Cost per lead | <£10 |
| Quality score | >7 |

---

*Start small, test fast, scale what works.*
