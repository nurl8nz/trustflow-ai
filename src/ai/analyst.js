import { generateJson } from './gemini.js';
import { ANALYSIS_SCHEMA, ANALYST_PROMPT, analystInput } from './prompts.js';

/** Raw (unvalidated) analysis from the model; callers pass it to normalizeAnalysis. */
export function analyzeAgreement(sourceText, clarifications = []) {
  return generateJson({
    system: ANALYST_PROMPT,
    contents: [{ role: 'user', parts: [{ text: analystInput(sourceText, clarifications) }] }],
    schema: ANALYSIS_SCHEMA,
  });
}
