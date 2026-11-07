import { HttpError } from '../util.js';

/** Small path router: "/api/agreements/:id" style patterns, exact method match. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });
      return { handler: route.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed.');
    return null;
  }
}

export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
