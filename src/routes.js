import { Router, redirect } from './http/router.js';
import { config, readiness } from './config.js';
import { store } from './store/db.js';
import { HttpError, clampBlock, clampText, createRateLimiter, isEmail, isHttpUrl, nowIso } from './util.js';
import {
  assertRole, normalizeAnalysis, createAgreement, presentAgreement, summarizeAgreement, getMilestone,
  updateMilestone, addClarifications, reanalyze, accept, setClientEmail, assertCanSubmit, markSubmitted,
  setReview, assertCanReview, markChangesRequested, applyPayPalStatus, log,
} from './domain/agreements.js';
import { analyzeAgreement } from './ai/analyst.js';
import { reviewDelivery } from './ai/reviewer.js';
import { runAgent, executeApproval, declineApproval } from './ai/agent.js';
import * as Payments from './services/payments.js';
import { verifyWebhook, webhookTarget } from './paypal/webhooks.js';
import { SAMPLES } from './samples.js';

const aiLimiter = createRateLimiter({ limit: config.limits.aiCallsPerHour, windowMs: 60 * 60 * 1000 });

function useAi(session) {
  if (!aiLimiter(session.id)) {
    throw new HttpError(429, 'You reached the hourly AI limit for this demo. Try again later.', { code: 'AI_LIMIT' });
  }
}

function findAgreement(session, id) {
  const agreement = session.workspace().agreements[id];
  if (!agreement) throw new HttpError(404, 'Agreement not found. It may have been removed when the demo server restarted.', { code: 'AGREEMENT_NOT_FOUND' });
  return agreement;
}

const roleOf = (ctx) => assertRole(ctx.body.role ?? ctx.query.role);

function respond(agreement, role) {
  store.save();
  return { agreement: presentAgreement(agreement, role) };
}

function addAgreement(session, agreement) {
  const ws = session.workspace();
  ws.agreements[agreement.id] = agreement;
  const ids = Object.values(ws.agreements).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((a) => a.id);
  while (ids.length > config.limits.agreementsPerWorkspace) delete ws.agreements[ids.shift()];
}

async function runReview(agreement, milestone) {
  if (!readiness().ai) return;
  try {
    setReview(agreement, milestone, await reviewDelivery(agreement, milestone));
  } catch (error) {
    setReview(agreement, milestone, { error: error.message, at: nowIso() });
  }
}

export function buildRoutes() {
  const r = new Router();

  r.get('/healthz', () => ({ ok: true }));

  r.get('/api/config', () => ({
    ready: readiness(),
    paypal: { env: config.paypal.env, clientId: config.paypal.clientId, sdkUrl: config.paypal.sdkUrl },
    ai: { provider: 'Google Gemini', model: config.gemini.model },
    demoClientEmail: config.demo.clientEmail,
    samples: Object.keys(SAMPLES),
  }));

  // ---------- Agreements ----------

  r.get('/api/agreements', ({ session }) => ({
    agreements: Object.values(session.workspace().agreements)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeAgreement),
  }));

  r.post('/api/agreements', async (ctx) => {
    const role = roleOf(ctx);
    const text = clampBlock(ctx.body.text, 4000);
    if (text.length < 30) throw new HttpError(400, 'Describe the deal in at least a sentence or two: what is delivered and for how much.', { code: 'TOO_SHORT' });
    useAi(ctx.session);
    const analysis = normalizeAnalysis(await analyzeAgreement(text), text);
    const agreement = createAgreement(analysis, { sourceText: text, origin: 'ai', model: config.gemini.model, clientEmail: config.demo.clientEmail });
    addAgreement(ctx.session, agreement);
    return respond(agreement, role);
  });

  r.post('/api/agreements/sample', (ctx) => {
    const role = roleOf(ctx);
    const sample = SAMPLES[ctx.body.sample];
    if (!sample) throw new HttpError(400, 'Unknown sample.');
    const agreement = createAgreement(normalizeAnalysis(sample.analysis, sample.text), {
      sourceText: sample.text, origin: 'sample', model: 'sample', clientEmail: config.demo.clientEmail,
    });
    addAgreement(ctx.session, agreement);
    return respond(agreement, role);
  });

  r.get('/api/agreements/:id', (ctx) => respond(findAgreement(ctx.session, ctx.params.id), roleOf(ctx)));

  r.delete('/api/agreements/:id', (ctx) => {
    findAgreement(ctx.session, ctx.params.id);
    delete ctx.session.workspace().agreements[ctx.params.id];
    store.save();
    return { ok: true };
  });

  r.patch('/api/agreements/:id', (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    if (ctx.body.clientEmail !== undefined) {
      const email = clampText(ctx.body.clientEmail, 120);
      if (email && !isEmail(email)) throw new HttpError(400, 'Enter a valid email address.', { code: 'BAD_EMAIL' });
      setClientEmail(agreement, email, role);
    }
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/clarify', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const answers = Array.isArray(ctx.body.answers) ? ctx.body.answers.slice(0, 10) : [];
    const added = addClarifications(agreement, answers, role);
    useAi(ctx.session);
    try {
      const analysis = normalizeAnalysis(await analyzeAgreement(agreement.sourceText, agreement.clarifications), agreement.sourceText);
      reanalyze(agreement, analysis, added.length);
    } catch (error) {
      agreement.clarifications.splice(-added.length);
      throw error;
    }
    return respond(agreement, role);
  });

  r.patch('/api/agreements/:id/milestones/:mid', (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    const { title, description, amount, deliverables, acceptanceCriteria } = ctx.body;
    updateMilestone(agreement, milestone, { title, description, amount, deliverables, acceptanceCriteria }, role);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/accept', (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    accept(agreement, role);
    return respond(agreement, role);
  });

  // ---------- PayPal funding (Orders API, intent AUTHORIZE) ----------

  r.post('/api/agreements/:id/milestones/:mid/order', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    const order = await Payments.startFunding(ctx.session.id, agreement, milestone, role, {
      baseUrl: ctx.baseUrl,
      redirect: ctx.body.flow === 'redirect',
    });
    return { orderId: order.id, approveUrl: order.approveUrl };
  });

  r.post('/api/agreements/:id/milestones/:mid/authorize', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    await Payments.completeFunding(ctx.session.id, agreement, milestone, role, String(ctx.body.orderId ?? ''));
    return respond(agreement, role);
  });

  // Redirect fallback when the SDK popup is unavailable. PayPal sends the buyer back here.
  r.get('/api/paypal/return', async (ctx) => {
    const orderId = String(ctx.query.token ?? '');
    const link = store.lookup(orderId);
    const found = store.resolve(link);
    if (!found || link.ws !== ctx.session.id) return redirect(ctx.res, '/#/?paypal=unknown');
    const { agreement, milestone } = found;
    try {
      await Payments.completeFunding(ctx.session.id, agreement, milestone, 'client', orderId);
      return redirect(ctx.res, `/#/a/${agreement.id}?paypal=funded`);
    } catch (error) {
      console.warn('[paypal] Return handling failed:', error.message);
      return redirect(ctx.res, `/#/a/${agreement.id}?paypal=failed`);
    }
  });

  r.get('/api/paypal/cancel', (ctx) => redirect(ctx.res, `/#/a/${encodeURIComponent(String(ctx.query.agreement ?? ''))}?paypal=cancelled`));

  // ---------- Work and payment release ----------

  r.post('/api/agreements/:id/milestones/:mid/submit', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    assertCanSubmit(agreement, milestone, role);
    const note = clampBlock(ctx.body.note, 2000);
    if (note.length < 10) throw new HttpError(400, 'Describe what you delivered so the client can check it.', { code: 'NOTE_TOO_SHORT' });
    const links = (Array.isArray(ctx.body.links) ? ctx.body.links : []).map((l) => clampText(l, 300)).filter(Boolean).slice(0, 5);
    const bad = links.find((l) => !isHttpUrl(l));
    if (bad) throw new HttpError(400, `“${bad}” is not a valid link. Links must start with http:// or https://.`, { code: 'BAD_LINK' });
    markSubmitted(agreement, milestone, { note, links, at: nowIso() });
    if (readiness().ai && aiLimiter(ctx.session.id)) await runReview(agreement, milestone);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/review', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    if (milestone.work !== 'submitted') throw new HttpError(409, 'There is no submitted work to check.');
    useAi(ctx.session);
    await runReview(agreement, milestone);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/approve', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    await Payments.approveAndRelease(agreement, getMilestone(agreement, ctx.params.mid), role);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/request-changes', (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    assertCanReview(agreement, milestone, role);
    const note = clampText(ctx.body.note, 600);
    if (note.length < 5) throw new HttpError(400, 'Say what needs to change.', { code: 'NOTE_TOO_SHORT' });
    markChangesRequested(agreement, milestone, note);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/cancel', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    await Payments.cancelMilestone(agreement, getMilestone(agreement, ctx.params.mid), role);
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/invoice', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const milestone = getMilestone(agreement, ctx.params.mid);
    const note = clampText(ctx.body.note, 600) || `Thank you! This invoice covers milestone ${milestone.number}, ${milestone.title}, which you approved.`;
    await Payments.issueInvoice(ctx.session.id, agreement, milestone, role, { note });
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/milestones/:mid/sync', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    await Payments.syncMilestone(agreement, getMilestone(agreement, ctx.params.mid));
    return respond(agreement, role);
  });

  // ---------- AI payment agent ----------

  r.post('/api/agreements/:id/agent', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const message = clampText(ctx.body.message, 800);
    if (!message) throw new HttpError(400, 'Type a message for the agent.');
    useAi(ctx.session);
    await runAgent({ wsId: ctx.session.id, agreement, role, message });
    return respond(agreement, role);
  });

  r.post('/api/agreements/:id/approvals/:aid/:decision', async (ctx) => {
    const role = roleOf(ctx);
    const agreement = findAgreement(ctx.session, ctx.params.id);
    const approval = agreement.agent.approvals.find((a) => a.id === ctx.params.aid);
    if (!approval) throw new HttpError(404, 'Approval card not found.');
    if (ctx.params.decision === 'approve') {
      try {
        await executeApproval({ agreement, approval, role });
      } finally {
        store.save();
      }
    } else if (ctx.params.decision === 'decline') {
      await declineApproval({ agreement, approval, role });
      log(agreement, role, `Declined the agent’s proposal for milestone ${approval.milestoneNumber}.`);
    } else {
      throw new HttpError(404, 'Unknown decision.');
    }
    return respond(agreement, role);
  });

  // ---------- PayPal webhooks ----------

  r.post('/api/webhooks/paypal', async (ctx) => {
    const event = ctx.body;
    const verified = await verifyWebhook(ctx.req.headers, event).catch((error) => {
      console.warn('[webhook] Verification call failed:', error.message);
      return false;
    });
    if (!verified) {
      console.warn(`[webhook] Ignored unverified event ${event?.event_type ?? '(unknown)'}`);
      return { received: true, applied: false };
    }
    const target = webhookTarget(event);
    const found = target && store.resolve(store.lookup(target.paypalId));
    if (!found) return { received: true, applied: false };
    const changed = applyPayPalStatus(found.agreement, found.milestone, target);
    if (changed) log(found.agreement, 'paypal', `Webhook ${event.event_type} received from PayPal.`);
    store.save();
    return { received: true, applied: changed };
  });

  return r;
}
