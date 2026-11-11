// `npm run deploy`. First run (no wrangler.local.toml) starts a short setup wizard:
// hostname, owner email, API keys, and (optionally) a Cloudflare API token so the Access
// login is created for you. Later runs just deploy. `npm run setup` re-runs the wizard.
//
// Personal values never touch git: the hostname goes in the gitignored wrangler.local.toml
// (prepended to wrangler.toml at deploy time), secrets go to Cloudflare with
// `wrangler secret put`, and the API token is used once in memory and discarded.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ask, confirm, secret } from './lib/prompt.mjs';
import { OPENROUTER_CHAT, OPENROUTER_STT, OPENROUTER_URL } from '../src/config.js';
import { setupAccess } from './lib/access.mjs';
import { DEFAULT_VECTOR_INDEX, localOverrides, overrideLines, mergeConfig } from './lib/merge.mjs';

const LOCAL = 'wrangler.local.toml';
const MERGED = '.wrangler.merged.toml';
const forceWizard = process.argv.includes('--setup');
const passthrough = process.argv.slice(2).filter((a) => a !== '--setup');
const interactive = process.stdin.isTTY && process.stdout.isTTY;

const wrangler = (args, opts = {}) => spawnSync('npx', ['wrangler', ...args], { stdio: 'inherit', ...opts });
const existingHost = () => existsSync(LOCAL) ? (readFileSync(LOCAL, 'utf8').match(/pattern\s*=\s*"([^"]+)"/) || [])[1] : '';
const hostOk = (h) => /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h);
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);


const CHAT_CHOICES = OPENROUTER_CHAT;
const STT_CHOICES = OPENROUTER_STT;

// Shows numbered options, then asks which one is the default and which others to offer in
// the dropdown. Answers are numbers, "all", or any model id typed in full.
async function pickModels(title, choices) {
  console.log(`\n${title}:`);
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.id}\n       ${c.note}`));
  console.log('  (or type any model id from openrouter.ai/models)');
  const toId = (t) => /^\d+$/.test(t) ? choices[Number(t) - 1]?.id : t;
  let first = '';
  while (!first) first = toId((await ask('Default (number or id)', { def: '1' })).trim()) || '';
  const more = await ask('Also offer in the dropdown (numbers/ids separated by commas, "all", or "none")', { def: 'none' });
  const extra = more === 'all' ? choices.map((c) => c.id)
    : more === 'none' ? [] : more.split(',').map((t) => toId(t.trim())).filter(Boolean);
  return [...new Set([first, ...extra])].join(',');
}

async function wizard() {
  // Where should Attest run? The rest of this wizard is the Cloudflare path.
  console.log('\nWhere should Attest run?');
  console.log('  1. Cloudflare + a hosted AI provider (OpenRouter or OpenAI). Reachable from anywhere. Recommended.');
  console.log('  2. This Mac only, with a local model server such as oMLX. Nothing leaves your machine; no API fees.');
  console.log('     (No Cloudflare account needed. Speaker detection and search work, with some trade-offs: see the README.)');
  if ((await ask('Choose 1 or 2', { def: '1' })).trim() === '2') {
    const { setupLocal } = await import('./local-setup.mjs');
    process.exit((await setupLocal()) ? 0 : 1);
  }
  console.log(`
Attest setup. Answers are used once and nothing here is committed to git.
Before you start, in the Cloudflare dashboard: enable R2 (R2 Object Storage) and, for
the automatic login setup, complete Zero Trust onboarding (Free plan). See the README.
`);
  let host = '';
  while (!hostOk(host)) host = (await ask('Hostname for Attest (a subdomain of a domain on your Cloudflare, e.g. attest.example.com)', { def: existingHost() })).toLowerCase();
  let email = '';
  while (!emailOk(email)) email = (await ask('Your email (the one you will log in with; it owns all recordings)')).toLowerCase();

  // Provider choice. Everything is stored as Worker secrets (the app reads them from env
  // like vars), so wrangler.toml stays untouched. Choosing OpenAI clears the OpenRouter
  // settings, so re-running setup can switch back.
  const PROVIDER_VARS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODELS', 'DEFAULT_MODEL', 'STT_BASE_URL', 'STT_API_KEY', 'STT_MODELS'];
  let provider = '';
  while (!['openai', 'openrouter'].includes(provider)) {
    provider = (await ask('AI provider: "openrouter" (recommended) or "openai"', { def: 'openrouter' })).toLowerCase();
  }
  const secrets = { OWNER_EMAIL: email };
  const remove = [];
  if (provider === 'openai') {
    secrets.OPENAI_API_KEY = await secret('OpenAI API key');
    remove.push(...PROVIDER_VARS);
  } else {
    console.log('\nOpenRouter handles summaries/mind maps/ask AND transcription with one key. Pick a\nmodel marked LABELS SPEAKERS if you want speaker names. Voiceprints are OpenAI-only.\nModel ids: openrouter.ai/models\n');
    const key = await secret('OpenRouter API key');
    const chat = await pickModels('Chat models (summaries, mind maps, ask)', CHAT_CHOICES);
    const stt = await pickModels('Transcription models', STT_CHOICES);
    Object.assign(secrets, {
      LLM_BASE_URL: OPENROUTER_URL, LLM_API_KEY: key, LLM_MODELS: chat, DEFAULT_MODEL: chat.split(',')[0].trim(),
      STT_BASE_URL: OPENROUTER_URL, STT_API_KEY: key, STT_MODELS: stt,
    });
    remove.push('OPENAI_API_KEY');
  }
  secrets.POCKET_API_KEY = await secret('Pocket API key (optional)');

  let access = null;
  if (await confirm('Create the Cloudflare Access login automatically? (needs an API token, see README)')) {
    const acct = (spawnSync('npx', ['wrangler', 'whoami'], { encoding: 'utf8' }).stdout || '').match(/\b[0-9a-f]{32}\b/g) || [];
    const accountId = await ask('Cloudflare account id', { def: [...new Set(acct)].length === 1 ? acct[0] : '' });
    const token = await secret('Cloudflare API token');
    if (accountId && token) access = { accountId, token };
  }

  const keep = existsSync(LOCAL) ? overrideLines(readFileSync(LOCAL, 'utf8')) : '';
  writeFileSync(LOCAL, `routes = [{ pattern = "${host}", custom_domain = true }]\n${keep ? keep + '\n' : ''}`);
  console.log(`\nWrote ${LOCAL} (gitignored).`);
  return { host, email, secrets, remove, access };
}

// Semantic search (optional): a Vectorize index plus a Workers AI binding. wrangler.toml stays
// as is, because a binding to an index that does not exist makes `wrangler deploy` fail. Instead
// we create the index here (idempotent) and append the bindings to the merged config only if
// that worked. Any failure just deploys without them; Ask then uses keyword search.
const vectorIndex = () => localOverrides(existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8') : '').vectorIndex || DEFAULT_VECTOR_INDEX;
function ensureVectorize() {
  if (process.env.ATTEST_NO_VECTORS) return false;
  const r = spawnSync('npx', ['wrangler', 'vectorize', 'create', vectorIndex(), '--dimensions=768', '--metric=cosine'], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 || /already exists|duplicate/i.test(out)) return true;
  console.log('! Could not create the Vectorize index; deploying without semantic search (keyword search still works).');
  console.log('  ' + out.trim().split('\n').slice(-2).join('\n  '));
  return false;
}

function mergedArgs(vectors) {
  if (!existsSync(LOCAL) && !vectors) return [];
  writeFileSync(MERGED, mergeConfig(existsSync(LOCAL) ? readFileSync(LOCAL, 'utf8') : '', readFileSync('wrangler.toml', 'utf8'), vectors ? vectorIndex() : ''));
  return ['-c', MERGED];
}

async function main() {
  let setup = null;
  if (interactive && (forceWizard || !existsSync(LOCAL))) setup = await wizard();
  else if (!existsSync(LOCAL)) console.log('No wrangler.local.toml: deploying without a custom domain. Run `npm run setup` (interactive) or see the README.');

  const cfg = mergedArgs(ensureVectorize());
  const dep = wrangler(['deploy', ...passthrough, ...cfg]);
  if (dep.status !== 0) process.exit(dep.status ?? 1);
  if (!setup) return;

  for (const [name, value] of Object.entries(setup.secrets)) {
    if (!value) { console.log(`- ${name}: skipped (set later: npx wrangler secret put ${name})`); continue; }
    const r = wrangler(['secret', 'put', name, ...cfg], { input: value + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
    if (r.status !== 0) console.log(`! could not set ${name}; run: npx wrangler secret put ${name}`);
  }

  for (const name of setup.remove) {
    // Best effort: the secret usually does not exist, which makes this fail harmlessly.
    wrangler(['secret', 'delete', name, ...cfg], { input: 'y\n', stdio: ['pipe', 'ignore', 'ignore'] });
  }

  if (setup.access) {
    try {
      await setupAccess({ ...setup.access, hostname: setup.host, email: setup.email, log: (m) => console.log('- ' + m) });
      console.log(`\nDone. Open https://${setup.host}, enter ${setup.email}, and use the emailed code.`);
      console.log('You can delete the API token now (dash.cloudflare.com/profile/api-tokens).');
    } catch (e) {
      console.log(`\nAccess setup failed: ${e.message}\nThe app is deployed but locked (401) until Access exists. Fix and re-run \`npm run setup\`, or do README step 6 by hand.`);
      process.exit(1);
    }
  } else {
    console.log(`\nDeployed at https://${setup.host}. Still to do: put Cloudflare Access in front of it (README step 6); until then it answers 401.`);
  }
}

main();
