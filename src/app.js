import http from 'node:http';
import crypto from 'node:crypto';
import { config, readiness } from './config.js';
import { store } from './store/db.js';
import { buildRoutes } from './routes.js';
import { readJson, sendJson } from './http/router.js';
import { serveStatic } from './http/static.js';
import { HttpError } from './util.js';

const COOKIE = 'tf_ws';
const WORKSPACE_ID = /^[a-f0-9]{32}$/;

function baseUrlOf(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

/**
 * Each browser gets its own private workspace via an HttpOnly cookie, so many
 * judges can try the hosted demo at once without seeing each other's data.
 */
function getSession(req, res, baseUrl) {
  const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
  let id = cookies[COOKIE];
  if (!WORKSPACE_ID.test(id ?? '')) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = baseUrl.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure}`);
  }
  return { id, workspace: () => store.workspace(id) };
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendError(res, error) {
  if (res.headersSent) return res.end();
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: { message: error.message, code: error.code, debugId: error.debugId } });
  }
  console.error('[server] Unexpected error:', error);
  return sendJson(res, 500, { error: { message: 'Something went wrong on the server. Try again.', code: 'INTERNAL' } });
}

export async function createServer() {
  await store.init();
  const router = buildRoutes();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    setSecurityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
    try {
      if (isApi) {
        const match = router.match(req.method, url.pathname);
        if (!match) throw new HttpError(404, 'Not found.');
        const baseUrl = baseUrlOf(req);
        const ctx = {
          req,
          res,
          url,
          baseUrl,
          params: match.params,
          query: Object.fromEntries(url.searchParams),
          body: ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {},
          session: getSession(req, res, baseUrl),
        };
        const result = await match.handler(ctx);
        if (!res.headersSent) sendJson(res, 200, result ?? {});
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
    } catch (error) {
      sendError(res, error);
    } finally {
      if (isApi && url.pathname !== '/healthz' && process.env.NODE_ENV !== 'test') {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });
}

export async function startServer() {
  const server = await createServer();
  server.listen(config.port, () => {
    const ready = readiness();
    const mark = (ok) => (ok ? 'ready' : 'missing');
    console.log(`\n  TrustFlow AI is running at http://localhost:${config.port}`);
    console.log(`  PayPal (${config.paypal.env}): ${mark(ready.paypal)}   Gemini (${config.gemini.model}): ${mark(ready.ai)}   Webhooks: ${ready.webhooks ? 'ready' : 'off (optional)'}`);
    if (!ready.paypal || !ready.ai) console.log('  Fill in .env (see .env.example), then restart.\n');
  });
  const shutdown = async () => {
    await store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
