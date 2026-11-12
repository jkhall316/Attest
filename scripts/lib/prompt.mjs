// Tiny terminal prompts with no dependencies. `secret` hides what you type.
import readline from 'node:readline';

export function ask(question, { def = '' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + (def ? ` [${def}]` : '') + ': ', (a) => { rl.close(); resolve(a.trim() || def); });
  });
}

export async function confirm(question, def = true) {
  const a = (await ask(`${question} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

export function secret(question) {
  // No raw mode when stdin is not a terminal (piped input, or Git Bash's mintty on Windows
  // without winpty): typing cannot be hidden there, so ask visibly rather than crash.
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return ask(`${question} (VISIBLE: this terminal cannot hide typing; Enter to skip)`);
  }
  return new Promise((resolve) => {
    process.stdout.write(question + ' (hidden, Enter to skip): ');
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n'); return resolve(buf.trim());
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}
