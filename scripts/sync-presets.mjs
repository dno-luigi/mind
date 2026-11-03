#!/usr/bin/env node
/**
 * Promote the presets in src/presets.js into your OpenRouter account.
 *
 *   npm run presets:sync                                   # dry run, prints bodies
 *   npm run presets:sync -- --model google/gemini-2.5-flash
 *   npm run presets:sync -- --model google/gemini-2.5-flash --apply
 *
 * Dry run is the default on purpose: applying overwrites the designated version
 * of any preset that already exists under the same slug.
 */

import { syncPlan } from '../src/preset-sync.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const modelFlag = args[args.indexOf('--model') + 1];
const model = args.includes('--model') ? modelFlag : undefined;

let plan;
try {
  plan = syncPlan({ model });
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

if (!plan.length) {
  console.error('No presets name an OpenRouter slug; nothing to sync.');
  process.exit(1);
}

console.log(`${apply ? 'Applying' : 'Dry run:'} ${plan.length} preset(s)\n`);
for (const item of plan) {
  console.log(`  ${item.slug}`);
  console.log(`    POST https://openrouter.ai/api/v1${item.path}`);
  console.log(`    ${JSON.stringify(item.body)}\n`);
}

if (!apply) {
  console.log('Nothing was sent. Re-run with --apply to write these versions.');
  process.exit(0);
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('✖ OPENROUTER_API_KEY is not set in this shell.');
  process.exit(1);
}

let failed = 0;
for (const item of plan) {
  const res = await fetch(`https://openrouter.ai/api/v1${item.path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(item.body),
  });

  if (!res.ok) {
    failed += 1;
    console.error(`  ✖ ${item.slug}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }

  const { data } = await res.json();
  console.log(`  ✔ ${item.slug} → version ${data?.designated_version?.version ?? '?'}`);
}

process.exit(failed ? 1 : 0);
