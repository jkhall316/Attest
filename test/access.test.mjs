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
