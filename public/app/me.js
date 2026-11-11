// "Who are you?": stored only in this browser. It makes "I", "me" and "my" in briefs and
// prompts mean you, puts your own action items first on Today, and tags you in talk balance.

const KEY = 'attest.me';

export const getMe = () => { try { return (localStorage.getItem(KEY) || '').trim().slice(0, 80); } catch { return ''; } };
export const setMe = (v) => { try { localStorage.setItem(KEY, String(v || '').trim().slice(0, 80)); } catch { /* private window */ } };

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);

// Does `name` (an action item owner, a speaker) refer to me? "Jeff" matches "Jeff Eberhard"
// and the reverse, on whole words only, so "Al" never matches "Alex".
export function isMe(name, me = getMe()) {
  const a = words(name), b = words(me);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w) => long.includes(w));
}
