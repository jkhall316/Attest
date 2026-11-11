// People (the speaker-name memory): finding likely duplicates and merging two people into
// one. Pure helpers only; the route is in routes/people.js.
//
// The usual cause is naming the same person two ways across recordings ("Jeff" in one,
// "Jeff Eberhard" in another). Merging renames the person everywhere, keeps their saved
// voice samples and remembered facts, and keeps the old name as an alias.

const tokens = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);

// Pairs that look like the same person: identical ignoring case, or every word of the
// shorter name is a whole word of the longer one ("Jeff" within "Jeff Eberhard"). Whole
// words only, so "Al" never matches "Alex Smith". The shorter name is merged INTO the longer.
export function suggestMerges(people) {
  const out = [];
  const list = (people || []).filter((p) => p?.id && p.name);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ta = tokens(a.name), tb = tokens(b.name);
      if (!ta.length || !tb.length) continue;
      const [short, long, ts, tl] = ta.length <= tb.length ? [a, b, ta, tb] : [b, a, tb, ta];
      if (ts.length === tl.length && ts.join(' ') !== tl.join(' ')) continue;
      if (!ts.every((t) => tl.includes(t))) continue;
      out.push({ from_id: short.id, from_name: short.name, into_id: long.id, into_name: long.name });
    }
  }
  return out;
}

// speakers[] with every label named `from` renamed to `into`. Confirmed stays confirmed.
export function renameSpeaker(speakers, from, into) {
  let changed = false;
  const out = (speakers || []).map((s) => {
    if (s?.name !== from) return s;
    changed = true;
    return { ...s, name: into };
  });
  return { speakers: out, changed };
}

// "a, b" alias text with `names` added, no duplicates (case-insensitive), the person's own
// name never listed as its own alias.
export function mergeAliases(existing, names, ownName) {
  const seen = new Set([String(ownName || '').toLowerCase()]);
  const out = [];
  for (const raw of [...String(existing || '').split(','), ...(names || [])]) {
    const n = String(raw || '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out.join(', ');
}
