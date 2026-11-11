// Creates the Cloudflare Access pieces for Attest through the Cloudflare API, idempotently:
//   1. a One-time PIN identity provider (reused if one exists)
//   2. a reusable Allow policy for the owner's email
//   3. a self-hosted Access application on the hostname, using both
// Needs an API token with: Account > "Access: Apps and Policies" Edit and
// "Access: Organizations, Identity Providers, and Groups" Edit.
// Zero Trust itself (team name + plan) must already exist: that onboarding takes a
// payment method and is dashboard-only.

const API = 'https://api.cloudflare.com/client/v4';
export const POLICY_NAME = 'Attest owner';
export const APP_NAME = 'Attest';

export async function setupAccess({ token, accountId, hostname, email, fetchImpl = fetch, log = () => {} }) {
  const call = async (method, path, body) => {
    const r = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      const why = (j.errors || []).map((e) => e.message).join('; ') || 'request failed';
      throw new Error(`${method} ${path} -> ${r.status}: ${why}`);
    }
    return j.result;
  };
  const base = `/accounts/${accountId}/access`;
  email = email.trim().toLowerCase();

  try {
    await call('GET', `${base}/organizations`);
  } catch (e) {
    throw new Error(
      'Could not read your Zero Trust organization. Either Zero Trust is not set up yet ' +
      '(dashboard -> Zero Trust, pick a team name and the Free plan) or the API token lacks ' +
      `the "Access: Organizations, Identity Providers, and Groups" permission. (${e.message})`);
  }

  // 1. identity provider
  const idps = (await call('GET', `${base}/identity_providers`)) || [];
  let idp = idps.find((i) => i.type === 'onetimepin');
  if (idp) log(`identity provider: reusing "${idp.name}"`);
  else {
    const flat = { name: 'One-time PIN', type: 'onetimepin', config: {} };
    try { idp = await call('POST', `${base}/identity_providers`, flat); }
    catch { idp = await call('POST', `${base}/identity_providers`, { identity_provider: flat }); }
    log('identity provider: created One-time PIN');
  }

  // 2. policy
  const policyBody = { name: POLICY_NAME, decision: 'allow', include: [{ email: { email } }] };
  const policies = (await call('GET', `${base}/policies`)) || [];
  let policy = policies.find((p) => p.name === POLICY_NAME);
  if (policy) {
    policy = await call('PUT', `${base}/policies/${policy.id}`, policyBody);
    log(`policy: updated "${POLICY_NAME}" -> allow ${email}`);
  } else {
    policy = await call('POST', `${base}/policies`, policyBody);
    log(`policy: created "${POLICY_NAME}" -> allow ${email}`);
  }

  // 3. application
  const appBody = {
    type: 'self_hosted', name: APP_NAME, domain: hostname,
    allowed_idps: [idp.id], app_launcher_visible: false, session_duration: '720h',
    policies: [{ id: policy.id, precedence: 1 }],
  };
  const apps = (await call('GET', `${base}/apps`)) || [];
  const existing = apps.find((a) => a.domain === hostname);
  const app = existing
    ? await call('PUT', `${base}/apps/${existing.id}`, appBody)
    : await call('POST', `${base}/apps`, appBody);
  log(`application: ${existing ? 'updated' : 'created'} "${APP_NAME}" on ${hostname}`);

  return { idpId: idp.id, policyId: policy.id, appId: app.id, created: !existing };
}
