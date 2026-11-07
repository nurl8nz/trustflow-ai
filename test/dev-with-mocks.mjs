// Runs the app against local PayPal and Gemini mocks: node test/dev-with-mocks.mjs
// Useful for working on the UI without any keys. No real APIs are called.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createPayPalMock, createGeminiMock, listen } from './mocks.mjs';

const paypal = createPayPalMock();
const gemini = createGeminiMock();
Object.assign(process.env, {
  PORT: process.env.PORT || '3000',
  DATA_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trustflow-dev-')), 'db.json'),
  PAYPAL_CLIENT_ID: 'mock-client',
  PAYPAL_CLIENT_SECRET: 'mock-secret',
  PAYPAL_API_BASE: await listen(paypal.server),
  GEMINI_API_KEY: 'mock-gemini-key',
  GEMINI_API_BASE: await listen(gemini.server),
  GEMINI_MODEL: 'mock-model',
});
const { startServer } = await import('../src/app.js');
await startServer();
console.log('  Using offline mocks for PayPal and Gemini.');
