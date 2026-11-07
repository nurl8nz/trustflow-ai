import { html, raw, esc, plural, shortDate, when } from './ui.js';

const WORK = {
  open: 'In progress',
  submitted: 'Waiting for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  cancelled: 'Cancelled',
};
const MONEY = {
  unfunded: 'Not funded',
  held: 'On hold in PayPal',
  released: 'Paid out',
  invoiced: 'Invoice sent',
  paid: 'Paid by invoice',
  returned: 'Hold voided',
};
const STATUS = { draft: 'Draft', active: 'Active', completed: 'Completed' };
const SEVERITY = { high: 'Could block payment', medium: 'Could cause friction', low: 'Good to settle' };
const ACTORS = { client: 'Client', freelancer: 'Freelancer', ai: 'AI', paypal: 'PayPal', system: 'TrustFlow' };

const busyAttr = (state, key) => (state.busy.has(key) ? raw('disabled data-busy="true"') : '');

// ---------- Shell ----------

export function sidebar(state) {
  const current = state.agreement?.id;
  return html`
    <a class="button button-primary button-block" href="#/" data-nav>New agreement</a>
    <h2 class="side-heading">Your agreements</h2>
    ${state.list.length
      ? html`<ul class="agreement-list">${state.list.map((a) => html`
          <li>
            <a href="#/a/${a.id}" class="agreement-link ${a.id === current ? 'is-current' : ''}" ${a.id === current ? raw('aria-current="page"') : ''}>
              <span class="agreement-link-title">${a.title}</span>
              <span class="agreement-link-meta"><span class="status-dot status-${a.status}"></span>${STATUS[a.status]}<span class="agreement-link-total">${a.total}</span></span>
            </a>
          </li>`)}</ul>`
      : html`<p class="side-empty">Agreements you create appear here. They are private to this browser.</p>`}
  `;
}

export function setupNotice(config) {
  const missing = [];
  if (!config.ready.paypal) missing.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  if (!config.ready.ai) missing.push('GEMINI_API_KEY');
  if (!missing.length) return '';
  return html`
    <div class="notice notice-warn" role="status">
      <p><strong>Setup needed.</strong> Add ${missing.join(' and ')} to the <code>.env</code> file, then restart the server.
      ${!config.ready.ai ? ' Until then you can still open the examples below.' : ''}</p>
    </div>`;
}

// ---------- Compose ----------

export function composeView(state) {
  const { config, busy, draftText } = state;
  const analyzing = busy.has('create');
  if (analyzing) return analyzingView();
  return html`
    ${setupNotice(config)}
    <section class="compose" aria-labelledby="compose-title">
      <h1 id="compose-title" class="display">Say the deal in your own words.</h1>
      <p class="lede">TrustFlow finds the parts people argue about later, turns the rest into milestones with clear checks, and has PayPal hold each payment until the work is approved.</p>
      <form class="compose-form" data-form="create">
        <label for="deal-text" class="visually-hidden">Describe your agreement</label>
        <textarea id="deal-text" name="text" rows="6" maxlength="4000" required data-draft="text"
          placeholder="Example: I need a website for my bakery for $900. $300 for the design, $400 for development and $200 after testing. It should be ready in about a month.">${draftText}</textarea>
        <div class="compose-row">
          <button type="submit" class="button button-primary button-large" ${config.ready.ai ? '' : raw('disabled')}>Check my agreement</button>
          <span class="compose-or">or start from an example</span>
          <button type="button" class="chip" data-action="sample" data-sample="bakery" ${busyAttr(state, 'sample')}>Bakery website, $900</button>
          <button type="button" class="chip" data-action="sample" data-sample="tutoring" ${busyAttr(state, 'sample')}>Math tutoring, 10 lessons</button>
        </div>
      </form>
    </section>
    <ol class="how" aria-label="How TrustFlow works">
      <li><h2>Describe</h2><p>Write the deal the way you would text it. Any language works.</p></li>
      <li><h2>Clarify</h2><p>The AI underlines vague words and asks one-line questions. Your answers become milestones with checks both sides can verify.</p></li>
      <li><h2>Fund and release</h2><p>The client funds a milestone with PayPal. The money waits on hold and moves only when the client approves the delivered work.</p></li>
    </ol>
    <p class="fineprint">TrustFlow helps two people understand each other. It is not legal advice and not a legal escrow service. This demo runs on the PayPal sandbox, so no real money moves.</p>
  `;
}

function analyzingView() {
  return html`
    <section class="analyzing" aria-live="polite" aria-busy="true">
      <h1 class="display">Reading your agreement…</h1>
      <ol class="analyzing-steps">
        <li>Finding the amounts and what each one pays for</li>
        <li>Writing checks that show when each part is done</li>
        <li>Underlining words that could start an argument</li>
      </ol>
      <p class="analyzing-time" id="analyzing-time">This usually takes under a minute.</p>
    </section>`;
}

// ---------- Agreement ----------

function proofread(text, gaps) {
  const marks = gaps.map((g, i) => ({ ...g, n: i + 1 })).filter((g) => g.span).sort((a, b) => a.span.start - b.span.start);
  let out = '';
  let pos = 0;
  for (const g of marks) {
    if (g.span.start < pos) continue;
    out += esc(text.slice(pos, g.span.start));
    // The underline sits on an inner span: Safari does not draw text-decoration on <button>.
    out += `<button type="button" class="proof proof-${g.severity}" data-action="focus-gap" data-gap="${esc(g.id)}" aria-label="${esc(`${text.slice(g.span.start, g.span.end)}: question ${g.n}`)}"><span class="proof-text">${esc(text.slice(g.span.start, g.span.end))}</span><sup>${g.n}</sup></button>`;
    pos = g.span.end;
  }
  return raw(out + esc(text.slice(pos)));
}

function clarityMeter(clarity) {
  const tone = clarity.score >= 80 ? 'good' : clarity.score >= 55 ? 'fair' : 'poor';
  return html`
    <div class="clarity clarity-${tone}">
      <p class="clarity-score"><span class="clarity-number">${clarity.score}</span><span class="clarity-of">/100</span></p>
      <div class="clarity-text">
        <p class="clarity-label">${clarity.label}</p>
        <div class="clarity-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clarity.score}" aria-label="Clarity score"><span style="width:${clarity.score}%"></span></div>
        <details class="clarity-why">
          <summary>How this score is counted</summary>
          ${clarity.factors.length
            ? html`<ul>${clarity.factors.map((f) => html`<li><span>${f.label}</span><span>${f.points}</span></li>`)}</ul>`
            : html`<p>Nothing is taking points away.</p>`}
          <p>The AI finds the issues. The score itself is simple arithmetic, so it means the same thing every time.</p>
        </details>
      </div>
    </div>`;
}

function gapsSection(a, state) {
  const draft = a.status === 'draft';
  if (!a.gaps.length) {
    return html`<section class="section" aria-labelledby="gaps-title"><h2 id="gaps-title">Open questions</h2><p class="muted">No open questions. Both sides can check every milestone as written.</p></section>`;
  }
  if (!draft) {
    return html`
      <details class="section gaps-folded">
        <summary><h2>${plural(a.gaps.length, 'question')} left open at signing</h2></summary>
        <ol class="gap-list">${a.gaps.map((g, i) => html`
          <li class="gap gap-${g.severity}" id="gap-${g.id}">
            <span class="gap-number" aria-hidden="true">${i + 1}</span>
            <div class="gap-body">
              <p class="gap-topic"><strong>${g.topic}</strong><span class="severity severity-${g.severity}">${SEVERITY[g.severity]}</span></p>
              <p>${g.issue}</p>
              <p class="gap-question">${g.question}</p>
            </div>
          </li>`)}</ol>
      </details>`;
  }
  return html`
    <section class="section" aria-labelledby="gaps-title">
      <div class="section-head">
        <h2 id="gaps-title">Settle these before you start</h2>
        <p class="muted">Answer in a few words. Leave a question blank to skip it.</p>
      </div>
      <form data-form="clarify" class="gaps">
        <ol class="gap-list">
          ${a.gaps.map((g, i) => html`
            <li class="gap gap-${g.severity}" id="gap-${g.id}">
              <span class="gap-number" aria-hidden="true">${i + 1}</span>
              <div class="gap-body">
                <p class="gap-topic"><strong>${g.topic}</strong><span class="severity severity-${g.severity}">${SEVERITY[g.severity]}</span></p>
                <p>${g.issue}</p>
                <p class="gap-risk">${g.risk}</p>
                ${html`
                  <label class="gap-question" for="answer-${g.id}">${g.question}</label>
                  <div class="gap-answer">
                    <input id="answer-${g.id}" name="${g.id}" type="text" maxlength="400" autocomplete="off" value="${state.answers[g.id] ?? ''}" data-draft="answer" data-gap="${g.id}">
                    ${g.suggestedClause ? html`<button type="button" class="button button-quiet button-small" data-action="use-suggestion" data-gap="${g.id}">Use suggested wording</button>` : ''}
                  </div>
                  ${g.suggestedClause ? html`<p class="gap-suggestion">Suggested: ${g.suggestedClause}</p>` : ''}`}
              </div>
            </li>`)}
        </ol>
        <div class="form-actions"><button type="submit" class="button button-primary" ${busyAttr(state, 'clarify')}>${state.busy.has('clarify') ? 'Updating the agreement…' : 'Update agreement with my answers'}</button></div>
      </form>
    </section>`;
}

function acceptanceSection(a, state) {
  if (a.status !== 'draft') return '';
  const row = (role) => html`
    <li class="${a.acceptance[role] ? 'is-done' : ''}">
      <span class="accept-mark" aria-hidden="true">${a.acceptance[role] ? '✓' : ''}</span>
      <span><strong>${role === 'client' ? 'Client' : 'Freelancer'}</strong> ${a.acceptance[role] ? `accepted ${when(a.acceptance[role])}` : 'has not accepted yet'}</span>
    </li>`;
  return html`
    <section class="section accept" aria-labelledby="accept-title">
      <h2 id="accept-title">Accept the terms</h2>
      <p class="muted">Both sides accept the milestones below. After that the terms are locked and the client can fund milestones. Editing a milestone resets both acceptances.</p>
      ${a.amountCheck.consistent ? '' : html`<p class="notice notice-warn">The milestones add up to ${a.amountCheck.sum}, but the agreement says ${a.amountCheck.stated}. Fix the amounts before accepting.</p>`}
      <ul class="accept-list">${row('client')}${row('freelancer')}</ul>
      ${a.you.canAccept ? html`<button type="button" class="button button-primary" data-action="accept" ${busyAttr(state, 'accept')}>Accept as the ${a.you.role}</button>` : ''}
    </section>`;
}

function criteriaList(m) {
  const review = m.review && !m.review.error ? m.review : null;
  return html`<ul class="criteria">${m.acceptanceCriteria.map((c, i) => {
    const r = review?.criteria[i];
    const status = r?.status ?? 'none';
    return html`<li class="criterion criterion-${status}">
      <span class="criterion-mark" aria-hidden="true"></span>
      <span>
        ${c.split(/(\[[^\]]+\])/g).map((part) => (/^\[[^\]]+\]$/.test(part) ? html`<span class="blank">${part}</span>` : part))}
        ${r ? html`<span class="criterion-review"><span class="visually-hidden">AI check: </span>${{ met: 'Evidence given', unclear: 'Not shown yet', not_met: 'Not done' }[status]}. ${r.evidence} ${r.checkHint ? html`<em>${r.checkHint}</em>` : ''}</span>` : ''}
      </span>
    </li>`;
  })}</ul>`;
}

function actionButtons(a, m, state) {
  const key = (k) => `${k}:${m.id}`;
  const busy = (k) => busyAttr(state, key(k));
  const out = [];
  for (const action of m.actions) {
    switch (action) {
      case 'edit': out.push(html`<button type="button" class="button button-quiet" data-action="edit-milestone" data-mid="${m.id}">Edit</button>`); break;
      case 'fund': out.push(html`<button type="button" class="button button-paypal" data-action="fund" data-mid="${m.id}" ${busy('fund')}>Fund ${m.amount} with PayPal</button>`); break;
      case 'submit': out.push(html`<button type="button" class="button button-primary" data-action="submit-work" data-mid="${m.id}">${m.work === 'changes_requested' ? 'Submit the changes' : 'Submit work'}</button>`); break;
      case 'approve': out.push(html`<button type="button" class="button button-primary" data-action="approve" data-mid="${m.id}" ${busy('approve')}>${m.money === 'held' ? `Approve and release ${m.amount}` : 'Approve work'}</button>`); break;
      case 'request_changes': out.push(html`<button type="button" class="button button-quiet" data-action="request-changes" data-mid="${m.id}">Ask for changes</button>`); break;
      case 'invoice': out.push(html`<button type="button" class="button button-primary" data-action="invoice" data-mid="${m.id}">Send PayPal invoice for ${m.amount}</button>`); break;
      case 'pay_invoice': out.push(html`<a class="button button-paypal" href="${m.invoice.payerUrl}" target="_blank" rel="noopener">Pay invoice in PayPal</a>`); break;
      case 'cancel': out.push(html`<button type="button" class="button button-text-danger" data-action="cancel" data-mid="${m.id}" ${busy('cancel')}>${m.money === 'held' ? 'Cancel and void the hold' : 'Cancel milestone'}</button>`); break;
      case 'sync': out.push(html`<button type="button" class="button button-text" data-action="sync" data-mid="${m.id}" ${busy('sync')}>${state.busy.has(key('sync')) ? 'Checking PayPal…' : 'Refresh from PayPal'}</button>`); break;
      default: break;
    }
  }
  if (a.you.role === 'client' && m.work === 'submitted' && (!m.review || m.review.error) && state.config.ready.ai) {
    out.push(html`<button type="button" class="button button-text" data-action="review" data-mid="${m.id}" ${busy('review')}>${state.busy.has(key('review')) ? 'Checking…' : 'Run AI delivery check'}</button>`);
  }
  return out;
}

function paypalRefs(a, m) {
  const rows = [];
  if (m.funding?.orderId) rows.push(['Order', m.funding.orderId]);
  if (m.funding?.authorizationId) rows.push(['Authorization', `${m.funding.authorizationId} (${m.funding.status})`]);
  if (m.money === 'held' && m.funding?.expiresAt) rows.push(['Hold valid until', shortDate(m.funding.expiresAt)]);
  if (m.funding?.captureId) rows.push(['Capture', `${m.funding.captureId} (${m.funding.captureStatus})`]);
  if (m.invoice?.id) rows.push(['Invoice', `${m.invoice.number ? `#${m.invoice.number} ` : ''}${m.invoice.id} (${m.invoice.status})`]);
  if (!rows.length) return '';
  return html`<dl class="refs">${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

function milestoneStation(a, m, state) {
  const expanded = state.expanded.has(m.id) || m.actions.some((x) => ['fund', 'submit', 'approve', 'invoice', 'pay_invoice'].includes(x));
  const funding = state.funding === m.id;
  return html`
    <li class="station money-${m.money} work-${m.work}" id="ms-${m.id}">
      <span class="station-dot" aria-hidden="true">${m.number}</span>
      <details class="station-card" ${expanded ? raw('open') : ''} data-mid="${m.id}">
        <summary>
          <span class="station-title">${m.title}${m.dueHint ? html`<span class="station-due">${m.dueHint}</span>` : ''}</span>
          <span class="station-amount">${m.amount}${m.amountSource === 'suggested' ? html`<span class="suggested" title="The AI suggested this amount. Edit it if it is wrong.">suggested</span>` : ''}</span>
          <span class="station-status">
            ${a.status === 'draft' ? '' : html`<span class="pill pill-work-${m.work}">${WORK[m.work]}</span>`}
            ${a.status === 'draft' ? '' : html`<span class="pill pill-money-${m.money}">${MONEY[m.money]}</span>`}
          </span>
        </summary>
        <div class="station-body">
          ${m.description ? html`<p>${m.description}</p>` : ''}
          <div class="station-columns">
            <div>
              <h3>Delivered</h3>
              <ul class="plain-list">${m.deliverables.map((d) => html`<li>${d}</li>`)}</ul>
            </div>
            <div>
              <h3>Done when</h3>
              ${m.acceptanceCriteria.length ? criteriaList(m) : html`<p class="muted">No checks yet. Edit the milestone to add some.</p>`}
            </div>
          </div>
          ${m.changeRequest && m.work === 'changes_requested' ? html`<div class="callout callout-warn"><h3>Client asked for changes</h3><p>${m.changeRequest.note}</p></div>` : ''}
          ${m.submission ? html`
            <div class="callout">
              <h3>Freelancer’s delivery note <span class="muted">${when(m.submission.at)}</span></h3>
              <p class="prewrap">${m.submission.note}</p>
              ${m.submission.links.length ? html`<ul class="links">${m.submission.links.map((l) => html`<li><a href="${l}" target="_blank" rel="noopener noreferrer">${l}</a></li>`)}</ul>` : ''}
            </div>` : ''}
          ${m.review?.error ? html`<p class="notice notice-warn">The AI delivery check did not run: ${m.review.error}</p>` : ''}
          ${m.review && !m.review.error ? html`
            <div class="callout callout-ai">
              <h3>AI delivery check</h3>
              <p>${m.review.summary}</p>
              ${m.review.questions.length ? html`<p class="muted">Worth asking: ${m.review.questions.join(' ')}</p>` : ''}
              <p class="fineprint">The AI only reads the note and cannot open links. The client decides.</p>
            </div>` : ''}
          ${paypalRefs(a, m)}
          ${funding
            ? html`<div class="fund-panel"><p>Approving in PayPal puts <strong>${m.amount}</strong> on hold. Nothing is charged until you approve the delivered work.</p><div class="fund-button" id="fund-${m.id}"></div><button type="button" class="button button-text" data-action="cancel-fund">Not now</button></div>`
            : html`<div class="station-actions">${actionButtons(a, m, state)}</div>`}
        </div>
      </details>
    </li>`;
}

function milestonesSection(a, state) {
  const t = a.totals;
  return html`
    <section class="section" aria-labelledby="ms-title">
      <div class="section-head section-head-row">
        <h2 id="ms-title">Milestones and payments</h2>
        ${a.status !== 'draft' ? html`
          <dl class="totals">
            <div><dt>On hold</dt><dd>${t.held}</dd></div>
            <div><dt>Paid out</dt><dd>${t.paid}</dd></div>
            <div><dt>Not paid yet</dt><dd>${t.open}</dd></div>
          </dl>` : ''}
      </div>
      <ol class="track">${a.milestones.map((m) => milestoneStation(a, m, state))}</ol>
      <p class="track-total"><span>Total</span><strong>${t.total}</strong></p>
    </section>`;
}

function clientEmailRow(a, state) {
  if (a.status === 'completed') return '';
  return html`
    <form class="email-row" data-form="client-email">
      <label for="client-email">Client’s PayPal email for invoices</label>
      <input id="client-email" name="clientEmail" type="email" value="${a.parties.clientEmail}" placeholder="name@example.com" autocomplete="off">
      <button type="submit" class="button button-quiet button-small" ${busyAttr(state, 'email')}>Save</button>
    </form>`;
}

function activitySection(a) {
  return html`
    <section class="section" aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      <ol class="history">${a.activity.map((e) => html`
        <li class="history-item actor-${e.actor}">
          <span class="history-actor">${ACTORS[e.actor] ?? e.actor}</span>
          <span class="history-text">${e.text}</span>
          <time datetime="${e.at}">${when(e.at)}</time>
        </li>`)}</ol>
    </section>`;
}

export function agreementView(state) {
  const a = state.agreement;
  if (!a) return html`<p class="muted loading-line">Loading…</p>`;
  return html`
    <article class="agreement">
      <header class="agreement-head">
        <p class="agreement-meta">
          <span class="status status-${a.status}">${STATUS[a.status]}</span>
          <span>${a.parties.clientLabel} pays ${a.parties.freelancerLabel}</span>
          ${a.origin === 'sample' ? html`<span class="muted">Example</span>` : ''}
        </p>
        <h1 class="agreement-title">${a.title}</h1>
        <p class="lede">${a.summary}</p>
        ${clarityMeter(a.clarity)}
      </header>

      <section class="section words" aria-labelledby="words-title">
        <h2 id="words-title">Your words, proofread</h2>
        <blockquote class="proofread">${proofread(a.sourceText, a.gaps)}</blockquote>
        ${a.clarifications.length ? html`
          <div class="clarified">
            <h3>Settled so far</h3>
            <ul>${a.clarifications.map((c) => html`<li><span class="muted">${c.topic}:</span> ${c.answer}</li>`)}</ul>
          </div>` : ''}
      </section>

      ${gapsSection(a, state)}
      ${milestonesSection(a, state)}
      ${acceptanceSection(a, state)}
      ${clientEmailRow(a, state)}
      ${activitySection(a)}
      <p class="agreement-foot"><button type="button" class="button button-text-danger" data-action="delete">Delete this agreement</button></p>
    </article>`;
}

// ---------- Agent ----------

const SUGGESTIONS = {
  client: ['What do I owe right now?', 'Release milestone 1 if the check looks good', 'What should I check before approving?'],
  freelancer: ['What is blocking my next payment?', 'Invoice the client for approved work', 'What does the client still need to do?'],
};

function approvalCard(card, role, state) {
  const title = {
    release_payment: `Approve milestone ${card.milestoneNumber} and release ${card.amount}`,
    cancel_milestone: `Cancel milestone ${card.milestoneNumber} and void any hold`,
    send_invoice: `Send PayPal invoice for ${card.amount}`,
  }[card.action];
  const mine = card.role === role;
  const busy = busyAttr(state, `approval:${card.id}`);
  return html`
    <li class="approval approval-${card.status}">
      <p class="approval-title">${title}</p>
      <p class="approval-sub">Milestone ${card.milestoneNumber}, ${card.milestoneTitle}</p>
      ${card.rationale ? html`<p class="approval-why">${card.rationale}</p>` : ''}
      ${card.status === 'pending'
        ? (mine
          ? html`<div class="approval-actions">
              <button type="button" class="button button-primary button-small" data-action="approval" data-decision="approve" data-approval="${card.id}" ${busy}>Approve</button>
              <button type="button" class="button button-quiet button-small" data-action="approval" data-decision="decline" data-approval="${card.id}" ${busy}>Decline</button>
            </div>`
          : html`<p class="muted">Waiting for the ${card.role} to approve.</p>`)
        : html`<p class="approval-result">${{ approved: 'Approved', declined: 'Declined', failed: `Failed: ${card.error ?? ''}` }[card.status]} ${when(card.resolvedAt)}</p>`}
    </li>`;
}

export function agentPanel(state) {
  const a = state.agreement;
  if (!a) return html``;
  const role = a.you.role;
  const messages = a.agent.messages.filter((m) => m.role === role || (m.role === 'agent' && m.for === role));
  const pending = a.agent.approvals.filter((c) => c.status === 'pending');
  const recent = a.agent.approvals.filter((c) => c.status !== 'pending').slice(-3).reverse();
  const thinking = state.busy.has('agent');
  return html`
    <div class="agent">
      <header class="agent-head">
        <h2>Payment agent</h2>
        <p>Working for you as the ${role}. It reads the agreement, checks PayPal, and ${role === 'client' ? 'prepares payment releases' : 'prepares PayPal invoices'}. It never moves money on its own: you approve every card.</p>
      </header>
      ${pending.length || recent.length ? html`<ul class="approvals" aria-label="Approval cards">${pending.map((c) => approvalCard(c, role, state))}${recent.map((c) => approvalCard(c, role, state))}</ul>` : ''}
      <ol class="chat" aria-live="polite">
        ${messages.length ? '' : html`<li class="chat-empty">Ask in plain words. For example:</li>`}
        ${messages.map((m) => html`
          <li class="bubble ${m.role === 'agent' ? 'bubble-agent' : 'bubble-you'}">
            ${m.trace?.length ? html`<ul class="trace">${m.trace.map((t) => html`<li class="${t.ok ? '' : 'trace-failed'}">${t.label}</li>`)}</ul>` : ''}
            <p class="prewrap">${m.text}</p>
          </li>`)}
        ${thinking ? html`<li class="bubble bubble-agent bubble-thinking"><p>Working on it…</p></li>` : ''}
      </ol>
      ${state.config.ready.ai ? html`
        <div class="suggestions">${SUGGESTIONS[role].map((s) => html`<button type="button" class="chip" data-action="ask" data-text="${s}" ${thinking ? raw('disabled') : ''}>${s}</button>`)}</div>
        <form class="agent-form" data-form="agent">
          <label for="agent-input" class="visually-hidden">Message the payment agent</label>
          <input id="agent-input" name="message" type="text" maxlength="800" autocomplete="off" placeholder="Ask the agent…" value="${state.agentDraft}" data-draft="agent" ${thinking ? raw('disabled') : ''}>
          <button type="submit" class="button button-primary" ${thinking ? raw('disabled') : ''}>Send</button>
        </form>`
        : html`<p class="muted">Add GEMINI_API_KEY to .env to use the agent.</p>`}
    </div>`;
}