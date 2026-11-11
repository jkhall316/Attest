// Building the config `wrangler deploy` uses: the gitignored wrangler.local.toml is put in front
// of wrangler.toml. It normally holds only the hostname, but an install that already exists in
// Cloudflare under other names can keep them there, so a deploy still finds its database:
//   name = "my-existing-worker"            replaces the Worker name in wrangler.toml
//   # vectorize_index = my-existing-index  the Vectorize index to use (a comment: wrangler ignores it)

export const DEFAULT_VECTOR_INDEX = 'attest-memory';

export function localOverrides(localText) {
  const t = String(localText || '');
  return {
    name: (t.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || '',
    vectorIndex: (t.match(/^#\s*vectorize_index\s*=\s*(\S+)/m) || [])[1] || '',
  };
}

// The override lines of an existing local file, so re-running the setup wizard keeps them.
export function overrideLines(localText) {
  return String(localText || '').split('\n').filter((l) => /^name\s*=\s*"/.test(l) || /^#\s*vectorize_index\s*=/.test(l)).join('\n');
}

export const vectorToml = (index) => `\n[ai]\nbinding = "AI"\n\n[[vectorize]]\nbinding = "VECTORS"\nindex_name = "${index}"\n`;

// local text + base text (+ vector bindings). A local `name` wins: TOML forbids two of the same key.
export function mergeConfig(localText, baseText, vectorIndex = '') {
  const local = String(localText || '');
  const base = localOverrides(local).name ? String(baseText).replace(/^name\s*=\s*"[^"]*"\n?/m, '') : String(baseText);
  return (local ? local.replace(/\n*$/, '\n') + '\n' : '') + base + (vectorIndex ? vectorToml(vectorIndex) : '');
}
