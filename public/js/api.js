export class ApiError extends Error {
  constructor(message, { status, code, debugId } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.debugId = debugId;
  }
}

async function request(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the TrustFlow server. Check that it is running, then try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.error?.message || `Request failed with status ${response.status}.`, {
      status: response.status, code: data.error?.code, debugId: data.error?.debugId,
    });
  }
  return data;
}

const a = (id) => `/api/agreements/${encodeURIComponent(id)}`;
const m = (id, mid) => `${a(id)}/milestones/${encodeURIComponent(mid)}`;

export const api = {
  config: () => request('GET', '/api/config'),
  list: () => request('GET', '/api/agreements'),
  create: (text, role) => request('POST', '/api/agreements', { text, role }),
  sample: (sample, role) => request('POST', '/api/agreements/sample', { sample, role }),
  get: (id, role) => request('GET', `${a(id)}?role=${role}`),
  remove: (id) => request('DELETE', a(id)),
  update: (id, role, fields) => request('PATCH', a(id), { role, ...fields }),
  clarify: (id, role, answers) => request('POST', `${a(id)}/clarify`, { role, answers }),
  editMilestone: (id, mid, role, fields) => request('PATCH', m(id, mid), { role, ...fields }),
  accept: (id, role) => request('POST', `${a(id)}/accept`, { role }),
  createOrder: (id, mid, flow = 'sdk') => request('POST', `${m(id, mid)}/order`, { role: 'client', flow }),
  authorize: (id, mid, orderId) => request('POST', `${m(id, mid)}/authorize`, { role: 'client', orderId }),
  submit: (id, mid, note, links) => request('POST', `${m(id, mid)}/submit`, { role: 'freelancer', note, links }),
  review: (id, mid, role) => request('POST', `${m(id, mid)}/review`, { role }),
  approve: (id, mid) => request('POST', `${m(id, mid)}/approve`, { role: 'client' }),
  requestChanges: (id, mid, note) => request('POST', `${m(id, mid)}/request-changes`, { role: 'client', note }),
  cancel: (id, mid) => request('POST', `${m(id, mid)}/cancel`, { role: 'client' }),
  invoice: (id, mid, note) => request('POST', `${m(id, mid)}/invoice`, { role: 'freelancer', note }),
  sync: (id, mid, role) => request('POST', `${m(id, mid)}/sync`, { role }),
  agent: (id, role, message) => request('POST', `${a(id)}/agent`, { role, message }),
  decide: (id, approvalId, decision, role) => request('POST', `${a(id)}/approvals/${encodeURIComponent(approvalId)}/${decision}`, { role }),
};
