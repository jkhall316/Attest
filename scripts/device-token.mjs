// `npm run device-token`: gives the Attest iPhone/Mac app a way in, on a deployment that already exists, without
// re-running the whole setup. It creates a Cloudflare Access service token (the Client ID and secret the app asks
// for) and a policy that lets only that token upload recordings, then tells the Worker how to verify it.
// Needs a Cloudflare API token with three Account permissions: Access: Apps and Policies Edit, Access: Organizations,
// Identity Providers, and Groups Edit, and Access: Service Tokens Edit. It is used once in memory and discarded. Run `npm run deploy` first so the Worker has the
// code that accepts the token.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { npx } from './lib/platform.mjs';
import { ask, secret } from './lib/prompt.mjs';
import { setupAccess, deviceInstructions } from './lib/access.mjs';
import { mergeConfig } from './lib/merge.mjs';

const LOCAL = 'wrangler.local.toml';
const MERGED = '.wrangler.merged.toml';
const host = existsSync(LOCAL) ? (readFileSync(LOCAL, 'utf8').match(/pattern\s*=\s*"([^"]+)"/) || [])[1] : '';
if (!host) {
  console.error('No deployment found (wrangler.local.toml has no hostname). Run `npm run setup` first.');
  process.exit(1);
}
if (!process.stdin.isTTY) { console.error('Run this in a terminal: it asks for your email and a Cloudflare API token.'); process.exit(1); }

const wrangler = (args, opts = {}) => npx(['wrangler', ...args], { stdio: 'inherit', ...opts });
writeFileSync(MERGED, mergeConfig(readFileSync(LOCAL, 'utf8'), readFileSync('wrangler.toml', 'utf8'), ''));
const cfg = ['-c', MERGED];

console.log(`Adding a device sign-in for https://${host}\n`);
const email = (await ask('The email you log in to Attest with')).toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('That does not look like an email.'); process.exit(1); }
const acct = (npx(['wrangler', 'whoami'], { encoding: 'utf8' }).stdout || '').match(/\b[0-9a-f]{32}\b/g) || [];
const accountId = await ask('Cloudflare account id', { def: [...new Set(acct)].length === 1 ? acct[0] : '' });
console.log('(The API token needs Account permissions: Access Apps and Policies Edit, Access Organizations/Identity Providers/Groups Edit, and Access Service Tokens Edit.)');
const token = await secret('Cloudflare API token');
if (!accountId || !token) { console.error('Need both the account id and an API token (see the README, step 3).'); process.exit(1); }

let acc;
try {
  acc = await setupAccess({ accountId, token, hostname: host, email, serviceToken: true, log: (m) => console.log('- ' + m) });
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
}
if (!acc.teamDomain || !acc.aud) {
  console.error('\nCould not read the Access team domain or application audience, so the Worker cannot verify the token. Set them by hand: npx wrangler secret put ACCESS_TEAM_DOMAIN / ACCESS_AUD (README, "Device sign-in").');
  process.exit(1);
}
// The cron and the device token both act as the owner, so the Worker must know who that is.
for (const [name, value] of [['ACCESS_TEAM_DOMAIN', acc.teamDomain], ['ACCESS_AUD', acc.aud], ['OWNER_EMAIL', email]]) {
  const r = wrangler(['secret', 'put', name, ...cfg], { input: value + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) console.log(`! could not set ${name}; run: npx wrangler secret put ${name}`);
}
console.log(deviceInstructions(host, acc.serviceToken));
