# HVAC BTU Calculator — Setup Guide

## Google Analytics 4 Tracking

This calculator includes non-intrusive Google Analytics 4 (GA4) tracking via the standard `gtag.js` pattern.

### 1. Get a GA4 Measurement ID

1. Go to [Google Analytics](https://analytics.google.com/) and sign in.
2. Create a new property (or use an existing one).
3. Choose **Web** as the platform.
4. Enter your website URL and stream name.
5. Copy the **Measurement ID** — it looks like `G-XXXXXXXXXX`.

### 2. Paste Your Measurement ID

Open `index.html` and replace **both** occurrences of the placeholder:

```html
<!-- Google Analytics 4: replace G-XXXXXXXXXX below with your real Measurement ID -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

Replace `G-XXXXXXXXXX` with your real ID in:
- the `src` URL of the first `<script>` tag
- the `'config'` call inside the second `<script>` tag

### 3. Verify Tracking

1. Deploy the updated `index.html` to your web server.
2. Open the calculator in a browser.
3. Use the **GA4 DebugView** (in Google Analytics → Admin → Data Streams → DebugView) or the **Tag Assistant** browser extension to confirm events are firing.

### Tracked Events

| Event Name | Trigger | Parameters |
|------------|---------|------------|
| `page_view` | Fired automatically by GA4 when the page loads. | Standard page info |
| `calculate_btu` | User clicks **Calculate BTU Requirement** and input is valid. | `unit` (`metric` / `imperial`), `btu`, `standard_btu` |
| `lead_form_start` | User clicks **Get Free Quotes** (intent signal before validation). | `has_result` (`true` / `false`) |
| `lead_form_submit` | Lead form passes validation and is submitted. | `has_result` (`true` / `false`) |
| `unit_toggle` | User switches between Metric and Imperial. | `unit` (`metric` / `imperial`) |
| `share_result` | User clicks **Share Result**. | `btu`, `standard_btu` (or `null` if no result) |

### Notes

- The tracking code is loaded **asynchronously**, so it will not block the calculator from rendering.
- Events are sent through a small `trackEvent()` helper that safely checks whether `gtag` is available.
- The placeholder `G-XXXXXXXXXX` will still work locally but will not send data to any real GA4 property until replaced.
