// Response + identity plumbing shared by every route module.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export const fail = (msg, status = 400) => json({ error: msg }, status);

export const uid = () => crypto.randomUUID();

// Single-user deploys: Cloudflare Access puts the email on the request, local dev
// has no header at all. Everything is scoped by this string.
export const ownerOf = (req) => req.headers.get('cf-access-authenticated-user-email') || 'local';
