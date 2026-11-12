// Creates the Cloudflare Access pieces for Attest through the Cloudflare API, idempotently:
//   1. a One-time PIN identity provider (reused if one exists)
//   2. a reusable Allow policy for the owner's email
//   3. a self-hosted Access application on the hostname, using both
// Needs an API token with: Account > "Access: Apps and Policies" Edit and
// "Access: Organizations, Identity Providers, and Groups" Edit (plus "Access: Service Tokens" Edit
// when serviceToken is on).
// Zero Trust itself (team name + plan) must already exist: that onboarding takes a
// payment method and is dashboard-only.

const API = 'https://api.cloudflare.com/client/v4';
export const POLICY_NAME = 'Attest owner';
export const APP_NAME = 'Attest';
export const DEVICE_POLICY_NAME = 'Attest device app';
export const TOKEN_NAME = 'Attest device app';

// What to tell the person after a service token exists: the three values for the Attest app, and a link that
// fills them in. The secret only exists at creation, so when it is gone say how to get a new one.
export function deviceInstructions(host, token) {
  const lines = [
    '',
    'For the Attest app on your iPhone or Mac, enter these on its first screen:',
    `  Server:        https://${host}`,
    `  Client ID:     ${token?.clientId || '(Zero Trust > Access > Service credentials)'}`,
    `  Client secret: ${token?.clientSecret || '(shown only when created: delete the "Attest device app" token in the dashboard and run this again)'}`,
  ];
  if (token?.clientId && token?.clientSecret) {
    const q = (v) => encodeURIComponent(v);
    lines.push('', 'Or open this link on the phone (AirDrop or Messages it to yourself); the app asks you to confirm the address:',
      `  attest://connect?server=${q('https://' + host)}&id=${q(token.clientId)}&secret=${q(token.clientSecret)}`);
  }
  lines.push('The secret is not stored anywhere else. Save it now.');
  return lines.join('\n');
}

// serviceToken: also create a service token + policy so a native device app (the Bluetooth pendant app)
// can get through Access without a login. The token's secret is only ever shown once, at creation.
export async function setupAccess({ token, accountId, hostname, email, serviceToken = false, fetchImpl = fetch, log = () => {} }) {
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

  let org = {};
  try {
    org = (await call('GET', `${base}/organizations`)) || {};
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

  // 2b. service token for the device app (optional): a token, and a non-identity policy that lets only it in
  let svc = null, svcPolicy = null;
  if (serviceToken) {
    const tokens = (await call('GET', `${base}/service_tokens`)) || [];
    let tok = tokens.find((t) => t.name === TOKEN_NAME);
    if (tok) log(`service token: reusing "${TOKEN_NAME}" (its secret was shown when it was created; rotate it in the dashboard to get a new one)`);
    else {
      tok = await call('POST', `${base}/service_tokens`, { name: TOKEN_NAME, duration: '8760h' });
      log(`service token: created "${TOKEN_NAME}"`);
    }
    svc = { clientId: tok.client_id, clientSecret: tok.client_secret || null };
    const dBody = { name: DEVICE_POLICY_NAME, decision: 'non_identity', include: [{ service_token: { token_id: tok.id } }] };
    const again = ((await call('GET', `${base}/policies`)) || []).find((x) => x.name === DEVICE_POLICY_NAME);
    svcPolicy = again ? await call('PUT', `${base}/policies/${again.id}`, dBody) : await call('POST', `${base}/policies`, dBody);
    log(`policy: ${again ? 'updated' : 'created'} "${DEVICE_POLICY_NAME}"`);
  }

  // 3. application
  const appBody = {
    type: 'self_hosted', name: APP_NAME, domain: hostname,
    allowed_idps: [idp.id], app_launcher_visible: false, session_duration: '720h',
    policies: [{ id: policy.id, precedence: 1 }, ...(svcPolicy ? [{ id: svcPolicy.id, precedence: 2 }] : [])],
  };
  const apps = (await call('GET', `${base}/apps`)) || [];
  const existing = apps.find((a) => a.domain === hostname);
  const app = existing
    ? await call('PUT', `${base}/apps/${existing.id}`, appBody)
    : await call('POST', `${base}/apps`, appBody);
  log(`application: ${existing ? 'updated' : 'created'} "${APP_NAME}" on ${hostname}`);

  return {
    idpId: idp.id, policyId: policy.id, appId: app.id, created: !existing,
    teamDomain: org.auth_domain || null, aud: app.aud || null, serviceToken: svc,
  };
}
