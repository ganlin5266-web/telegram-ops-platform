import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

const web = fileURLToPath(new URL('../', import.meta.url));
const env = loadEnv('production', web, 'VITE_');
if (process.env.VITE_API_BASE || env.VITE_API_BASE) {
  console.error('VITE_API_BASE must be empty'); process.exit(1);
}
if (!process.argv.includes('--prebuild')) {
  const forbidden = [/DATABASE_URL/i, /DB_PASSWORD/i, /TELEGRAM_BOT_TOKEN/i,
    /WEBHOOK_SECRET/i, /SESSION_SECRET/i, /QUERY_CURSOR_SECRET/i,
    /telegram-ops-platform\.onrender\.com/i, /lovableproject\.com/i,
    /API_PROXY_TARGET/, /PUBLIC_PREVIEW_ORIGIN/,
    /postgres(?:ql)?:\/\//i, /\b\d{6,12}:[A-Za-z0-9_-]{30,50}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/];
  let count = 0;
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Bundle symlink rejected');
      if (entry.isDirectory()) { await scan(path); continue; }
      const content = await readFile(path, 'utf8'); count++;
      if (forbidden.some(pattern => pattern.test(content))) throw new Error('Forbidden bundle content');
    }
  }
  try { await scan(resolve(web, 'dist')); console.log(`Bundle scan: ${count} files, 0 findings`); }
  catch { console.error('Bundle scan failed (content redacted)'); process.exit(1); }
}
