// Thin fetch wrapper: prefixes /api, and turns a non-2xx into a thrown Error whose
// message is the server's {error} string (or the raw body for non-JSON responses).

export const api = async (path, opts) => {
  const r = await fetch('/api' + path, opts);
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    if (ct.includes('json')) throw new Error((await r.json()).error);
    // A proxy or crash page is HTML: never paste it into the UI.
    const body = (await r.text()).trim();
    throw new Error(body.startsWith('<') || !body ? `Request failed (${r.status})` : body.slice(0, 300));
  }
  return ct.includes('json') ? r.json() : r.text();
};
