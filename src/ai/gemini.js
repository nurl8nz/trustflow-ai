import { config } from '../config.js';
import { HttpError } from '../util.js';

export function assertAiConfigured() {
  if (!config.gemini.apiKey) {
    throw new HttpError(503, 'AI is not configured. Add GEMINI_API_KEY to .env and restart.', { code: 'AI_NOT_CONFIGURED' });
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One call to the Gemini generateContent REST endpoint.
 * Returns the model's content (kept intact so function-call turns, including
 * thought signatures, can be sent back unchanged) and its parts.
 */
// Less thinking makes structured answers much faster. If the model rejects a
// level, we step to the next one and remember it for later calls.
const THINKING_LEVELS = ['minimal', 'low'];
let thinkingStep = 0;

export async function generate({ system, contents, schema, tools, maxAttempts = 3 }) {
  assertAiConfigured();
  const url = `${config.gemini.apiBase}/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: schema ? { responseMimeType: 'application/json', responseSchema: schema } : {},
  };
  const applyThinking = () => {
    if (thinkingStep < THINKING_LEVELS.length) body.generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVELS[thinkingStep] };
    else delete body.generationConfig.thinkingConfig;
  };
  applyThinking();
  if (tools?.length) body.tools = [{ functionDeclarations: tools }];

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      // A timeout means the model is slow, not down: retrying would only double the wait.
      if (error.name === 'TimeoutError') {
        throw new HttpError(504, 'The AI took too long to answer. Try again, or set a faster GEMINI_MODEL in .env.', { code: 'AI_TIMEOUT' });
      }
      lastError = new HttpError(502, `Could not reach the AI service (${error.message}).`, { code: 'AI_UNREACHABLE' });
      await sleep(600 * attempt);
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const candidate = data.candidates?.[0];
      if (!candidate?.content) {
        const reason = data.promptFeedback?.blockReason || candidate?.finishReason || 'no content';
        throw new HttpError(422, `The AI returned no answer (${reason}). Rephrase and try again.`, { code: 'AI_EMPTY' });
      }
      return { content: candidate.content, parts: candidate.content.parts ?? [], finishReason: candidate.finishReason };
    }
    const message = data.error?.message || `AI request failed with status ${response.status}.`;
    if (response.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(message)) {
      console.warn(`[gemini] Model rejected thinking level "${THINKING_LEVELS[thinkingStep]}", trying the next option.`);
      thinkingStep += 1;
      applyThinking();
      attempt -= 1;
      continue;
    }
    if (response.status === 402) throw new HttpError(503, 'The prepaid Gemini credit is used up. Add credit in Google AI Studio > Billing.', { code: 'AI_NO_CREDIT' });
    if (response.status === 429) lastError = new HttpError(429, 'The AI quota is used up for the moment. Wait a minute and try again.', { code: 'AI_RATE_LIMITED' });
    else if (response.status === 400 || response.status === 404) throw new HttpError(502, `AI request rejected: ${message} Check GEMINI_MODEL in .env.`, { code: 'AI_BAD_REQUEST' });
    else if (response.status === 401 || response.status === 403) throw new HttpError(502, 'The AI key was rejected. Check GEMINI_API_KEY in .env.', { code: 'AI_AUTH' });
    else lastError = new HttpError(502, message, { code: 'AI_ERROR' });
    if (!RETRYABLE.has(response.status)) break;
    await sleep(800 * attempt * attempt);
  }
  throw lastError;
}

export const textOf = (parts) => parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();

/** Structured output: Gemini is constrained to the schema; we still parse defensively. */
export async function generateJson(options) {
  const { parts } = await generate(options);
  const text = textOf(parts).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'The AI returned malformed data. Try again.', { code: 'AI_BAD_JSON' });
  }
}