// Migration script: Set default coverage_areas for existing contractors
// Run once to backfill coverage_areas based on existing postcode prefixes
//
// Run with: node scripts/migrate-coverage-areas.js
//
// Deliberately kept outside api/ (see the Vercel function-count fix in
// ACCONNX-PROGRESS.md) — this is a one-off manual script, not an HTTP
// handler, and Vercel's zero-config detection would otherwise register it
// as its own (unused) serverless function. @supabase/supabase-js and dotenv
// live in api/node_modules, not a top-level node_modules, so they're
// resolved explicitly from there.
const path = require('path');
const { createClient } = require(path.join(__dirname, '../api/node_modules/@supabase/supabase-js'));
require(path.join(__dirname, '../api/node_modules/dotenv')).config({ path: path.join(__dirname, '../api/.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function migrateCoverageAreas() {
  console.log('🔄 Starting coverage_areas migration...\n');

  // Get all companies
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, company, postcode, coverage_areas');

  if (error) {
    console.error('❌ Failed to fetch companies:', error.message);
    process.exit(1);
  }

  console.log(`Found ${companies.length} companies\n`);

  let updated = 0;
  let skipped = 0;

  for (const company of companies) {
    // Skip if already has coverage_areas set
    if (company.coverage_areas && company.coverage_areas.length > 0) {
      console.log(`⏭️  ${company.company}: already has coverage_areas [${company.coverage_areas.join(', ')}]`);
      skipped++;
      continue;
    }

    // Extract postcode prefix (e.g., "SK9 1AA" → "SK")
    const postcode = company.postcode || '';
    const prefix = postcode.split(' ')[0] || '';
    
    // Build default coverage: first 2 letters of postcode prefix
    // e.g., "SK9" → ["SK"], "M1" → ["M"]
    let defaultCoverage = [];
    if (prefix.length >= 2) {
      // Get the area code (letters only)
      const areaCode = prefix.replace(/[0-9]/g, '');
      if (areaCode) {
        defaultCoverage = [areaCode];
      }
    }

    if (defaultCoverage.length === 0) {
      console.log(`⚠️  ${company.company}: could not determine coverage from postcode "${postcode}"`);
      skipped++;
      continue;
    }

    // Update the company
    const { error: updateError } = await supabase
      .from('companies')
      .update({ 
        coverage_areas: defaultCoverage,
        updated_at: new Date().toISOString()
      })
      .eq('id', company.id);

    if (updateError) {
      console.log(`❌ ${company.company}: update failed — ${updateError.message}`);
    } else {
      console.log(`✅ ${company.company}: set coverage_areas to [${defaultCoverage.join(', ')}]`);
      updated++;
    }
  }

  console.log(`\n📊 Migration complete:`);
  console.log(`   ✅ Updated: ${updated}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);
  console.log(`   📝 Total: ${companies.length}`);
}

migrateCoverageAreas().catch(console.error);
