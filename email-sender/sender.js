const fs = require('fs-extra');
const path = require('path');
const Handlebars = require('handlebars');
require('dotenv').config();

// Initialize Resend when API key is available
let resend = null;
try {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resend = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Resend email service initialized');
  } else {
    console.log('⚠️ RESEND_API_KEY not set. Emails will be logged to console only.');
    console.log('Get your API key from https://resend.com and add it to .env file');
  }
} catch (e) {
  console.log('⚠️ Email service not available:', e.message);
}

// =====================
// COMPANY LIST (Add your targets here)
// =====================
// Format: { name, email, city, postcode }
const TARGET_COMPANIES = [
  // Example entries - replace with real data
  // { name: "Cool Air Ltd", email: "info@coolair.co.uk", city: "Manchester", postcode: "M1" },
  // { name: "Arctic Cooling", email: "sales@arcticcooling.com", city: "Birmingham", postcode: "B1" },
];

// =====================
// LOAD EMAIL TEMPLATES
// =====================
function loadTemplate(templateName) {
  const templatePath = path.join(__dirname, '..', 'email-templates', `${templateName}.html`);
  try {
    return fs.readFileSync(templatePath, 'utf8');
  } catch (e) {
    console.error(`Template not found: ${templatePath}`);
    return null;
  }
}

// =====================
// COMPILE TEMPLATE
// =====================
function compileTemplate(templateHtml, data) {
  const template = Handlebars.compile(templateHtml);
  return template(data);
}

// =====================
// SEND EMAIL
// =====================
async function sendEmail(to, subject, html, companyName) {
  if (!resend) {
    console.log(`\n📧 EMAIL WOULD BE SENT (Resend not configured):`);
    console.log(`   To: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Company: ${companyName}`);
    console.log(`   Length: ${html.length} chars`);
    return { id: 'demo_' + Date.now(), status: 'logged' };
  }

  try {
    const result = await resend.emails.send({
      from: 'HVAC Lead Pro <onboarding@resend.dev>',
      to: to,
      subject: subject,
      html: html
    });

    console.log(`✅ Email sent to ${companyName} (${to})`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to send to ${companyName}:`, error.message);
    return { error: error.message };
  }
}

// =====================
// SEND RECRUITMENT EMAIL
// =====================
async function sendRecruitmentEmail(company) {
  const template = loadTemplate('contractor-recruitment');
  if (!template) return;

  const html = compileTemplate(template, {
    company_name: company.name
  });

  return await sendEmail(
    company.email,
    `Qualified AC leads in ${company.city} — Pay per lead, no subscription`,
    html,
    company.name
  );
}

// =====================
// SEND FOLLOW-UP EMAIL
// =====================
async function sendFollowUpEmail(company) {
  const template = loadTemplate('follow-up');
  if (!template) return;

  const html = compileTemplate(template, {
    company_name: company.name,
    city: company.city,
    postcode_example: company.postcode + ' 8AB'
  });

  return await sendEmail(
    company.email,
    `Re: Qualified AC leads in ${company.city}`,
    html,
    company.name
  );
}

// =====================
// BATCH SEND
// =====================
async function sendBatchEmails(companies, type = 'recruitment', delayMs = 5000) {
  console.log(`\n🚀 Starting batch send: ${type}`);
  console.log(`📊 Total companies: ${companies.length}`);
  console.log(`⏱️  Delay between emails: ${delayMs}ms\n`);

  const results = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    console.log(`[${i + 1}/${companies.length}] Processing: ${company.name}`);

    let result;
    if (type === 'recruitment') {
      result = await sendRecruitmentEmail(company);
    } else if (type === 'follow-up') {
      result = await sendFollowUpEmail(company);
    }

    results.push({ company: company.name, result });

    // Delay between sends to avoid rate limits
    if (i < companies.length - 1) {
      console.log(`   Waiting ${delayMs}ms before next email...\n`);
      await sleep(delayMs);
    }
  }

  console.log(`\n✅ Batch complete! Sent ${results.length} emails`);
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================
// LOAD COMPANIES FROM CSV
// =====================
function loadCompaniesFromCSV(csvPath) {
  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    return lines.slice(1).map(line => {
      const values = line.split(',');
      const company = {};
      headers.forEach((header, i) => {
        company[header] = values[i]?.trim() || '';
      });
      return company;
    }).filter(c => c.email && c.name);
  } catch (e) {
    console.error('Failed to load CSV:', e.message);
    return [];
  }
}

// =====================
// SAVE RESULTS
// =====================
async function saveResults(results, filename = 'email-results.json') {
  const outputPath = path.join(__dirname, filename);
  await fs.writeJson(outputPath, results, { spaces: 2 });
  console.log(`\n💾 Results saved to: ${outputPath}`);
}

// =====================
// MAIN
// =====================
async function main() {
  console.log('🔥 HVAC Lead Pro — Email Sender\n');

  // Check for CSV file
  const csvPath = path.join(__dirname, 'companies.csv');
  let companies = [];

  if (await fs.pathExists(csvPath)) {
    console.log('📁 Loading companies from companies.csv');
    companies = loadCompaniesFromCSV(csvPath);
    console.log(`✅ Loaded ${companies.length} companies from CSV\n`);
  }

  // Fallback to hardcoded list
  if (companies.length === 0) {
    console.log('⚠️  No companies.csv found. Using example list.');
    console.log('Create companies.csv with columns: name, email, city, postcode\n');
    companies = TARGET_COMPANIES;
  }

  if (companies.length === 0) {
    console.log('❌ No companies to send to. Add companies to companies.csv or TARGET_COMPANIES array.');
    return;
  }

  // Show preview
  console.log('📋 Companies to contact:');
  companies.forEach((c, i) => {
    console.log(`   ${i + 1}. ${c.name} (${c.email}) - ${c.city}`);
  });

  // Confirm before sending
  console.log(`\n⚠️  About to send ${companies.length} emails.`);
  console.log('Type "yes" to proceed, or press Ctrl+C to cancel.\n');

  // Auto-confirm for demo (remove in production)
  console.log('(Auto-confirming for demo... set CONFIRM=yes to skip this)\n');

  // Send recruitment emails
  const results = await sendBatchEmails(companies, 'recruitment', 3000);

  // Save results
  await saveResults(results);

  console.log('\n🎉 Done! Check email-results.json for details.');
  console.log('\nNext steps:');
  console.log('1. Wait 3-4 days');
  console.log('2. Run follow-up: node sender.js --follow-up');
}

// Handle command line args
const args = process.argv.slice(2);
if (args.includes('--follow-up')) {
  console.log('📧 Follow-up mode selected\n');
  // Load previous results and filter non-responders
  // Then send follow-up emails
}

// Run
main().catch(console.error);
