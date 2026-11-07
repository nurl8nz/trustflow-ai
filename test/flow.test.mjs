// End-to-end test of the whole product flow against local PayPal and Gemini mocks.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createPayPalMock, createGeminiMock, listen } from './mocks.mjs';

const paypal = createPayPalMock();
const gemini = createGeminiMock();
let app;
let base;
let cookie = '';

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = res.status === 303 ? { location: res.headers.get('location') } : await res.json();
  return { status: res.status, data };
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustflow-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_FILE: path.join(dataDir, 'db.json'),
    PAYPAL_CLIENT_ID: 'mock-client',
    PAYPAL_CLIENT_SECRET: 'mock-secret',
    PAYPAL_API_BASE: await listen(paypal.server),
    GEMINI_API_KEY: 'mock-gemini-key',
    GEMINI_API_BASE: await listen(gemini.server),
    PAYPAL_WEBHOOK_ID: '',
  });
  const { createServer } = await import('../src/app.js');
  app = await createServer();
  base = await listen(app);
});

after(() => {
  app?.close();
  paypal.server.close();
  gemini.server.close();
});

test('config reports both integrations ready', async () => {
  const { data } = await api('GET', '/api/config');
  assert.equal(data.ready.paypal, true);
  assert.equal(data.ready.ai, true);
  assert.match(data.paypal.sdkUrl, /web-sdk\/v6\/core/);
});

test('full flow: analyze, clarify, accept, fund, deliver, review, release, invoice', async () => {
  // 1. AI turns plain words into milestones and gaps.
  let { status, data } = await api('POST', '/api/agreements', { role: 'client', text: 'I need a modern website for my bakery. $900: $300 design, $400 development, $200 after testing.' });
  assert.equal(status, 200, JSON.stringify(data));
  let a = data.agreement;
  assert.equal(a.milestones.length, 3);
  assert.equal(a.totals.total, '$900.00');
  assert.ok(a.gaps.length >= 5);
  assert.deepEqual(a.gaps[0].span !== null, true, 'quote found in source text');
  const firstScore = a.clarity.score;

  // 2. Answering questions re-runs the analysis and raises the clarity score.
  ({ data } = await api('POST', `/api/agreements/${a.id}/clarify`, {
    role: 'client',
    answers: [{ gapId: a.gaps[0].id, answer: 'Home, Menu, About, Contact' }, { gapId: a.gaps[1].id, answer: 'Rosa tests within 5 days' }],
  }));
  a = data.agreement;
  assert.ok(a.clarity.score > firstScore, `score ${firstScore} -> ${a.clarity.score}`);
  assert.equal(a.clarifications.length, 2);

  // 3. Funding is blocked until both sides accept.
  ({ status } = await api('POST', `/api/agreements/${a.id}/milestones/${a.milestones[0].id}/order`, { role: 'client' }));
  assert.equal(status, 409);
  await api('POST', `/api/agreements/${a.id}/accept`, { role: 'client' });
  ({ data } = await api('POST', `/api/agreements/${a.id}/accept`, { role: 'freelancer' }));
  a = data.agreement;
  assert.equal(a.status, 'active');

  // 4. Freelancer cannot fund; client creates an AUTHORIZE order and authorizes it.
  const m1 = a.milestones[0];
  ({ status } = await api('POST', `/api/agreements/${a.id}/milestones/${m1.id}/order`, { role: 'freelancer' }));
  assert.equal(status, 403);
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m1.id}/order`, { role: 'client' }));
  const { orderId } = data;
  const orderCall = paypal.calls.find((c) => c.path === '/v2/checkout/orders');
  assert.equal(orderCall.body.intent, 'AUTHORIZE');
  assert.equal(orderCall.body.purchase_units[0].amount.value, '300.00');
  assert.ok(orderCall.requestId, 'PayPal-Request-Id header sent');

  ({ status } = await api('POST', `/api/agreements/${a.id}/milestones/${m1.id}/authorize`, { role: 'client', orderId: 'SOMEONE-ELSES-ORDER' }));
  assert.equal(status, 400, 'foreign order ids are rejected');
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m1.id}/authorize`, { role: 'client', orderId }));
  a = data.agreement;
  assert.equal(a.milestones[0].money, 'held');
  assert.equal(a.totals.held, '$300.00');

  // 5. Freelancer submits; AI checks each acceptance criterion.
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m1.id}/submit`, { role: 'freelancer', note: 'Mockups for all four pages, phone and desktop.', links: ['https://figma.com/file/demo'] }));
  a = data.agreement;
  assert.equal(a.milestones[0].work, 'submitted');
  assert.equal(a.milestones[0].review.criteria.length, a.milestones[0].acceptanceCriteria.length);

  // 6. Client approves through the agent's approval card: capture happens only then.
  ({ data } = await api('POST', `/api/agreements/${a.id}/agent`, { role: 'client', message: 'Release milestone 1 if it looks fine' }));
  a = data.agreement;
  const card = a.agent.approvals.find((x) => x.status === 'pending');
  assert.equal(card.action, 'release_payment');
  assert.equal(paypal.calls.some((c) => c.path.endsWith('/capture')), false, 'agent did not move money by itself');
  ({ data } = await api('POST', `/api/agreements/${a.id}/approvals/${card.id}/approve`, { role: 'client' }));
  a = data.agreement;
  assert.equal(a.milestones[0].work, 'approved');
  assert.equal(a.milestones[0].money, 'released');
  assert.equal(a.totals.paid, '$300.00');

  // 7. Milestone 2: delivered and approved without a hold, then billed by PayPal invoice via the agent.
  const m2 = a.milestones[1];
  await api('POST', `/api/agreements/${a.id}/milestones/${m2.id}/submit`, { role: 'freelancer', note: 'Site is live on the preview link.', links: ['https://preview.example'] });
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m2.id}/approve`, { role: 'client' }));
  assert.equal(data.agreement.milestones[1].money, 'unfunded');
  ({ data } = await api('POST', `/api/agreements/${a.id}/agent`, { role: 'freelancer', message: 'Invoice the client for what is approved' }));
  a = data.agreement;
  const invoiceCard = a.agent.approvals.find((x) => x.status === 'pending' && x.action === 'send_invoice');
  assert.ok(invoiceCard, 'agent prepared an invoice card');
  assert.equal(a.milestones[1].invoice.status, 'DRAFT');
  ({ data } = await api('POST', `/api/agreements/${a.id}/approvals/${invoiceCard.id}/approve`, { role: 'freelancer' }));
  a = data.agreement;
  assert.equal(a.milestones[1].money, 'invoiced');
  assert.match(a.milestones[1].invoice.payerUrl, /invoice/);

  // 8. Sync picks up the paid invoice from PayPal.
  await fetch(`${process.env.PAYPAL_API_BASE}/__mock/invoices/${a.milestones[1].invoice.id}/pay`, { method: 'POST', headers: { Authorization: 'Bearer mock-token' } });
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m2.id}/sync`, { role: 'freelancer' }));
  assert.equal(data.agreement.milestones[1].money, 'paid');

  // 9. Milestone 3: funded then cancelled, so the hold is voided.
  const m3 = a.milestones[2];
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m3.id}/order`, { role: 'client' }));
  await api('POST', `/api/agreements/${a.id}/milestones/${m3.id}/authorize`, { role: 'client', orderId: data.orderId });
  ({ data } = await api('POST', `/api/agreements/${a.id}/milestones/${m3.id}/cancel`, { role: 'client' }));
  a = data.agreement;
  assert.equal(a.milestones[2].money, 'returned');
  assert.equal(a.status, 'completed');
});

test('samples work without the AI and workspaces are isolated', async () => {
  const { data } = await api('POST', '/api/agreements/sample', { role: 'client', sample: 'tutoring' });
  assert.equal(data.agreement.milestones.length, 2);
  const mine = await api('GET', '/api/agreements');
  assert.ok(mine.data.agreements.length >= 2);
  const saved = cookie;
  cookie = '';
  const stranger = await api('GET', '/api/agreements');
  assert.equal(stranger.data.agreements.length, 0);
  const peek = await api('GET', `/api/agreements/${data.agreement.id}?role=client`);
  assert.equal(peek.status, 404);
  cookie = saved;
});

test('unverified webhooks are ignored', async () => {
  const { data } = await api('POST', '/api/webhooks/paypal', { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });
  assert.equal(data.applied, false);
});
