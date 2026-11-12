// Cloudflare Access service tokens, for native device apps (the Bluetooth pendant app) that cannot do an
// interactive login. Access has already authenticated the request at the edge and put a signed JWT
// in Cf-Access-Jwt-Assertion; we verify that signature ourselves against the team's published keys
// rather than trusting the bare header, because a header is only as trustworthy as whatever sits in
// front of the Worker. A service token carries no email, so it is honoured only when it verifies,
// only as the owner (OWNER_EMAIL), and only on the two routes a device app needs (see
// serviceTokenMayCall), so a leaked token cannot read recordings or change settings.
//
// Needs ACCESS_TEAM_DOMAIN (e.g. myteam.cloudflareaccess.com) and ACCESS_AUD (the Access application's
// audience tag); without both, service tokens are simply off.

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

let certCache = { at: 0, team: '', keys: [] };
const CERT_TTL_MS = 10 * 60 * 1000;

async function signingKeys(team, force = false) {
  if (!force && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`access certs ${r.status}`);
  const keys = (await r.json()).keys || [];
  certCache = { at: Date.now(), team, keys };
  return keys;
}

// The verified payload of a service-token JWT, or null for anything else (missing, forged, expired,
// wrong audience, or a signed-in person rather than a token).
export async function verifyServiceToken(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = String(env.ACCESS_AUD || '').trim();
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!team || !aud || !jwt) return null;
  try {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;
    const head = json(h);
    if (head.alg !== 'RS256') return null;
    let jwk = (await signingKeys(team)).find((k) => k.kid === head.kid);
    if (!jwk) jwk = (await signingKeys(team, true)).find((k) => k.kid === head.kid); // keys rotate
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const c = json(p);
    const now = Date.now() / 1000;
    if (!(c.exp > now) || (c.nbf && c.nbf > now + 60)) return null;
    if (![].concat(c.aud || []).includes(aud)) return null;
    if (c.iss && c.iss !== `https://${team}`) return null;
    return c.common_name && !c.email ? c : null; // a service token: it names a client, not a person
  } catch {
    return null;
  }
}

// What a device app is allowed to do: upload a recording and read the app's settings it needs.
export const serviceTokenMayCall = (method, pathname) =>
  (method === 'POST' && pathname === '/api/recordings') || (method === 'GET' && pathname === '/api/meta');
