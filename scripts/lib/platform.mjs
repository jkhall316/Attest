// The few places the setup scripts behave differently on Windows (and Linux) than on a Mac.
// Each helper takes the platform as an argument so the tests can check every case on any OS.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Was this module started directly (`node scripts/x.mjs`) rather than imported?
// `import.meta.url === \`file://${process.argv[1]}\`` only works on macOS and Linux: on Windows
// the URL is file:///C:/... while argv[1] is C:\..., so the scripts silently did nothing.
// Both sides go through realpath, and Windows compares case-insensitively (drive letters and
// folders can be typed in either case).
export function isMain(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const a = real(fileURLToPath(metaUrl)), b = real(argv1);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// One argument for cmd.exe: bare when it is plainly safe, double-quoted otherwise. Trailing
// backslashes are doubled so they cannot escape the closing quote. (cmd still expands %VAR%
// inside quotes; none of the arguments deploy.mjs builds contain %.)
const cmdQuote = (arg) => (/^[\w@+=:,./\\-]+$/.test(arg)
  ? arg
  : `"${String(arg).replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`);

// How to run `npx <args>`. On Windows npx is npx.cmd, which Node (since the CVE-2024-27980
// fix) refuses to spawn without a shell, and passing an args array with `shell: true` is
// deprecated (DEP0190), so Windows gets one quoted command line.
export function npxSpawn(args, platform = process.platform) {
  if (platform === 'win32') return { command: ['npx', ...args].map(cmdQuote).join(' '), args: [], shell: true };
  return { command: 'npx', args, shell: false };
}

export function npx(args, opts = {}) {
  const s = npxSpawn(args);
  return spawnSync(s.command, s.args, { ...opts, shell: s.shell });
}

// How the setup wizard refers to the machine it runs on.
export const machineLabel = (platform = process.platform) => (platform === 'darwin' ? 'this Mac' : 'this computer');

// Ports `setup:local` tries, in order. Mac: oMLX (8000) first. Elsewhere: LM Studio (1234) and
// Ollama (11434) first, because 8000 is also Speaches' default and that is a transcription-only
// server, not the one to use for chat.
export const defaultPorts = (platform = process.platform) => (platform === 'darwin'
  ? [8000, 11434, 11436, 1234]
  : [1234, 11434, 8000, 11436]);
