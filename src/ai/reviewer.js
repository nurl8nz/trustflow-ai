import { generateJson } from './gemini.js';
import { REVIEW_SCHEMA, REVIEWER_PROMPT, reviewerInput } from './prompts.js';
import { clampText, cleanList, nowIso } from '../util.js';

const STATUSES = ['met', 'unclear', 'not_met'];

/** Advisory check of a submission against acceptance criteria. Never decides on its own. */
export async function reviewDelivery(agreement, milestone) {
  const raw = await generateJson({
    system: REVIEWER_PROMPT,
    contents: [{ role: 'user', parts: [{ text: reviewerInput(agreement, milestone) }] }],
    schema: REVIEW_SCHEMA,
  });
  const returned = Array.isArray(raw?.criteria) ? raw.criteria : [];
  // Align with the real criteria list so the model cannot add, drop or reword checks.
  const criteria = milestone.acceptanceCriteria.map((criterion, i) => {
    const match = returned.find((c) => clampText(c?.criterion, 240).toLowerCase() === criterion.toLowerCase()) ?? returned[i] ?? {};
    return {
      criterion,
      status: STATUSES.includes(match.status) ? match.status : 'unclear',
      evidence: clampText(match.evidence, 240),
      checkHint: clampText(match.check_hint, 240),
    };
  });
  const overall = criteria.some((c) => c.status === 'not_met')
    ? 'incomplete'
    : criteria.every((c) => c.status === 'met') ? 'ready_for_review' : 'needs_evidence';
  return {
    overall,
    summary: clampText(raw?.summary, 500),
    criteria,
    questions: cleanList(raw?.questions_for_freelancer, 3, 200),
    at: nowIso(),
  };
}
