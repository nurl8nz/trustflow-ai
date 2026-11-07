import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Serves files from /public, with an SPA fallback to index.html for extensionless paths. */
export async function serveStatic(req, res, pathname) {
  const root = config.publicDir;
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  let file = path.normalize(path.join(root, relative));
  if (!file.startsWith(root + path.sep)) return notFound(res);

  let stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    if (path.extname(relative)) return notFound(res);
    file = path.join(root, 'index.html');
    stat = await fs.stat(file);
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(await fs.readFile(file));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}