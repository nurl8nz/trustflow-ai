// Local stand-ins for the PayPal REST API and the Gemini API, so the full
// flow can be tested offline: `npm test`. They mimic the response shapes the
// app relies on, not every field of the real APIs.
import http from 'node:http';
import { SAMPLES } from '../src/samples.js';

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

export function createPayPalMock() {
  const orders = new Map();
  const auths = new Map();
  const invoices = new Map();
  const calls = [];
  let n = 0;
  const id = (p) => `${p}${String(++n).padStart(6, '0')}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const b = ['POST', 'PATCH'].includes(req.method) ? await body(req).catch(() => ({})) : {};
    calls.push({ method: req.method, path: p, requestId: req.headers['paypal-request-id'], body: b });

    if (p === '/v1/oauth2/token') return json(res, 200, { access_token: 'mock-token', expires_in: 3600 });
    if (req.headers.authorization !== 'Bearer mock-token') return json(res, 401, { error: 'invalid_token' });

    let m;
    if (req.method === 'POST' && p === '/v2/checkout/orders') {
      const orderId = id('ORDER');
      const order = { id: orderId, intent: b.intent, status: 'PAYER_ACTION_REQUIRED', purchase_units: b.purchase_units, links: [{ rel: 'payer-action', href: `https://sandbox.example/checkoutnow?token=${orderId}` }] };
      orders.set(orderId, order);
      return json(res, 200, order);
    }
    if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/))) {
      const order = orders.get(m[1]);
      if (!order) return json(res, 404, { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' });
      if (order.status === 'COMPLETED') return json(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_AUTHORIZED', description: 'Order already authorized.' }] });
      const authId = id('AUTH');
      const unit = order.purchase_units[0];
      const auth = { id: authId, status: 'CREATED', amount: unit.amount, expiration_time: new Date(Date.now() + 29 * 864e5).toISOString() };
      auths.set(authId, auth);
      order.status = 'COMPLETED';
      order.payer = { email_address: 'buyer@sandbox.example' };
      order.purchase_units = [{ ...unit, payments: { authorizations: [auth] } }];
      return json(res, 201, order);
    }
    if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && req.method === 'GET') {
      return orders.has(m[1]) ? json(res, 200, orders.get(m[1])) : json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/))) {
      const auth = auths.get(m[1]);
      if (!auth || auth.status !== 'CREATED') return json(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }] });
      auth.status = 'CAPTURED';
      return json(res, 201, { id: id('CAP'), status: 'COMPLETED', create_time: new Date().toISOString() });
    }
    if ((m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/))) {
      const auth = auths.get(m[1]);
      if (!auth) return json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
      auth.status = 'VOIDED';
      res.writeHead(204); return res.end();
    }
    if ((m = p.match(/^\/v2\/payments\/authorizations\/([^/]+)$/))) {
      return auths.has(m[1]) ? json(res, 200, auths.get(m[1])) : json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if (req.method === 'POST' && p === '/v2/invoicing/invoices') {
      const invId = id('INV2-MOCK-');
      invoices.set(invId, { id: invId, status: 'DRAFT', detail: { ...b.detail, invoice_number: String(n) }, items: b.items, primary_recipients: b.primary_recipients });
      return json(res, 201, invoices.get(invId));
    }
    if ((m = p.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/))) {
      const inv = invoices.get(m[1]);
      inv.status = 'SENT';
      inv.detail.metadata = { recipient_view_url: `https://sandbox.example/invoice/p/#${inv.id}` };
      return json(res, 200, { rel: 'payer-view', href: inv.detail.metadata.recipient_view_url });
    }
    if ((m = p.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/))) {
      if (req.method === 'DELETE') { invoices.delete(m[1]); res.writeHead(204); return res.end(); }
      return invoices.has(m[1]) ? json(res, 200, invoices.get(m[1])) : json(res, 404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = p.match(/^\/__mock\/invoices\/([^/]+)\/pay$/))) {
      invoices.get(m[1]).status = 'PAID';
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { name: 'NOT_FOUND', message: `${req.method} ${p}` });
  });
  return { server, calls, orders, auths, invoices };
}

function analysisFor(contents) {
  const text = contents.at(-1).parts[0].text;
  const raw = structuredClone(SAMPLES.bakery.analysis);
  if (text.includes('Answers the parties gave')) {
    raw.gaps = raw.gaps.slice(2);
    raw.milestones[0].acceptance_criteria = ['Mockups cover Home, Menu, About and Contact', 'Each page has a phone and a desktop version', 'Rosa has had 2 rounds of revisions'];
  }
  return raw;
}

function reviewFor(contents) {
  const text = contents.at(-1).parts[0].text;
  const criteria = [...text.matchAll(/^\d+\. (.+)$/gm)].map((x) => x[1]);
  return {
    overall: 'needs_evidence',
    summary: 'Most checks have a link; one is only claimed.',
    criteria: criteria.map((c, i) => ({ criterion: c, status: i === criteria.length - 1 ? 'unclear' : 'met', evidence: 'The note links to it.', check_hint: 'Open the link and confirm.' })),
    questions_for_freelancer: ['Can you share a screenshot of the revision history?'],
  };
}

function agentTurn(reqBody) {
  const tools = reqBody.tools?.[0]?.functionDeclarations?.map((t) => t.name) ?? [];
  const last = reqBody.contents.at(-1).parts;
  const firstUser = [...reqBody.contents].reverse().find((c) => c.role === 'user' && c.parts[0].text)?.parts[0].text ?? '';
  const call = (name, args = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig' }] } }] });
  const say = (text) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] });

  if (last[0].text) return call('get_agreement_state');
  const response = last[0].functionResponse;
  if (response?.name === 'get_agreement_state') {
    const state = response.response.result;
    if (tools.includes('prepare_invoice') && /invoice/i.test(firstUser)) {
      const target = state.milestones.find((m) => m.work_status === 'approved' && m.payment_status === 'unfunded');
      if (target) return call('prepare_invoice', { milestone_number: target.number, note_to_client: 'Thanks for approving this milestone.' });
    }
    if (tools.includes('propose_release_payment') && /release/i.test(firstUser)) {
      const target = state.milestones.find((m) => m.work_status === 'submitted');
      if (target) return call('propose_release_payment', { milestone_number: target.number, rationale: 'The delivery check found evidence for the main criteria.' });
    }
    return say(`You have ${state.milestones.length} milestones. Nothing needs your approval right now.`);
  }
  return say('Done. Approve the card below to continue.');
}

export function createGeminiMock() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const b = await body(req).catch(() => ({}));
    calls.push(b);
    if (req.headers['x-goog-api-key'] !== 'mock-gemini-key') return json(res, 403, { error: { message: 'bad key' } });
    const system = b.systemInstruction?.parts?.[0]?.text ?? '';
    let reply;
    if (system.includes('agreement analyst')) reply = { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(analysisFor(b.contents)) }] } }] };
    else if (system.includes('delivery checker')) reply = { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reviewFor(b.contents)) }] } }] };
    else reply = agentTurn(b);
    json(res, 200, reply);
  });
  return { server, calls };
}

export const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
