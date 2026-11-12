import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAccess } from '../scripts/lib/access.mjs';

// A tiny fake of the three Access collections, so we exercise the real request flow.
function fakeApi({ org = true, idps = [], policies = [], apps = [] } = {}) {
  const log = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4/accounts/A1/access', '');
    const method = init.method; const body = init.body ? JSON.parse(init.body) : null;
    log.push([method, path, body]);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    const bad = (m) => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: m }] }) });
    if (path === '/organizations') return org ? ok({}) : bad('no org');
    const coll = { '/identity_providers': idps, '/policies': policies, '/apps': apps };
    if (method === 'GET') return ok(coll[path]);
    const [, name, id] = path.split('/');
    const list = coll['/' + name];
    if (method === 'POST') { const r = { id: `id${++n}`, ...(body.identity_provider || body) }; list.push(r); return ok(r); }
    const r = { ...list.find((x) => x.id === id), ...body }; list[list.findIndex((x) => x.id === id)] = r; return ok(r);
  };
  return { fetchImpl, log, idps, policies, apps };
}
const args = { token: 't', accountId: 'A1', hostname: 'attest.example.com', email: ' Me@Example.COM ' };

test('creates idp, policy and app on a fresh account, lowercasing the email', async () => {
  const api = fakeApi();
  const out = await setupAccess({ ...args, fetchImpl: api.fetchImpl });
  assert.equal(out.created, true);
  assert.equal(api.idps[0].type, 'onetimepin');
  assert.deepEqual(api.policies[0].include, [{ email: { email: 'me@example.com' } }]);
  const app = api.apps[0];
  assert.equal(app.domain, 'attest.example.com');
  assert.deepEqual(app.allowed_idps, [api.idps[0].id]);
  assert.deepEqual(app.policies, [{ id: api.policies[0].id, precedence: 1 }]);
});

test('is idempotent: a second run updates instead of duplicating', async () => {
  const api = fakeApi();
  await setupAccess({ ...args, fetchImpl: api.fetchImpl });
  const out = await setupAccess({ ...args, email: 'new@example.com', fetchImpl: api.fetchImpl });
  assert.equal(out.created, false);
  assert.equal(api.idps.length, 1); assert.equal(api.policies.length, 1); assert.equal(api.apps.length, 1);
  assert.equal(api.policies[0].include[0].email.email, 'new@example.com');
});

test('reuses an existing one-time-pin provider', async () => {
  const api = fakeApi({ idps: [{ id: 'x', name: 'PIN', type: 'onetimepin' }] });
  await setupAccess({ ...args, fetchImpl: api.fetchImpl });
  assert.equal(api.idps.length, 1);
  assert.deepEqual(api.apps[0].allowed_idps, ['x']);
});

test('explains what to do when Zero Trust is not set up', async () => {
  await assert.rejects(
    () => setupAccess({ ...args, fetchImpl: fakeApi({ org: false }).fetchImpl }),
    /Zero Trust is not set up yet/);
});

test('serviceToken: creates a token and a non-identity policy, and puts both policies on the app', async () => {
  const api = fakeApi();
  const origFetch = api.fetchImpl;
  const tokens = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.cloudflare.com/client/v4/accounts/A1/access', '');
    if (path === '/organizations') return { ok: true, status: 200, json: async () => ({ success: true, result: { auth_domain: 'team.cloudflareaccess.com' } }) };
    if (path === '/service_tokens') {
      if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ success: true, result: tokens.map(({ client_secret, ...rest }) => rest) }) }; // the API never lists secrets
      const t = { id: 'tok1', client_id: 'cid.access', client_secret: 'sec', name: JSON.parse(init.body).name }; tokens.push(t);
      return { ok: true, status: 200, json: async () => ({ success: true, result: t }) };
    }
    const r = await origFetch(url, init);
    if (path === '/apps' && init.method !== 'GET') { const j = await r.json(); j.result.aud = 'AUD9'; return { ok: true, status: 200, json: async () => j }; }
    return r;
  };
  const out = await setupAccess({ ...args, serviceToken: true, fetchImpl });
  assert.deepEqual(out.serviceToken, { clientId: 'cid.access', clientSecret: 'sec' });
  assert.equal(out.teamDomain, 'team.cloudflareaccess.com');
  assert.equal(out.aud, 'AUD9');
  const dev = api.policies.find((p) => p.name === 'Attest device app');
  assert.equal(dev.decision, 'non_identity');
  assert.deepEqual(dev.include, [{ service_token: { token_id: 'tok1' } }]);
  assert.deepEqual(api.apps[0].policies.map((p) => p.precedence), [1, 2]);
  // a second run reuses the token (its secret cannot be read again) and does not duplicate the policy
  const again = await setupAccess({ ...args, serviceToken: true, fetchImpl });
  assert.equal(tokens.length, 1);
  assert.equal(again.serviceToken.clientSecret, null);
  assert.equal(api.policies.filter((p) => p.name === 'Attest device app').length, 1);
});

test('without serviceToken the app has only the owner policy, as before', async () => {
  const api = fakeApi();
  const out = await setupAccess({ ...args, fetchImpl: api.fetchImpl });
  assert.equal(out.serviceToken, null);
  assert.equal(api.apps[0].policies.length, 1);
});

test('deviceInstructions prints the three app values and a link that carries a tricky secret intact', async () => {
  const { deviceInstructions } = await import('../scripts/lib/access.mjs');
  const out = deviceInstructions('attest.example.com', { clientId: 'abc.access', clientSecret: 's&c=ret/+ x' });
  assert.match(out, /Server: +https:\/\/attest\.example\.com/);
  assert.match(out, /Client ID: +abc\.access/);
  const link = out.match(/attest:\/\/connect\?\S+/)[0];
  const q = new URL(link.replace('attest://', 'https://')).searchParams;
  assert.equal(q.get('server'), 'https://attest.example.com');
  assert.equal(q.get('id'), 'abc.access');
  assert.equal(q.get('secret'), 's&c=ret/+ x', 'survives the round trip');
  const reuse = deviceInstructions('attest.example.com', { clientId: 'abc.access', clientSecret: null });
  assert.doesNotMatch(reuse, /attest:\/\/connect/, 'no link without a secret');
  assert.match(reuse, /delete the "Attest device app" token/, 'says how to get a new secret');
});
