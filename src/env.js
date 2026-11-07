import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader (no dependency). Values already in process.env win,
 * so a host like Render can override anything that is in the file.
 */
export function loadEnvFile(file = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
