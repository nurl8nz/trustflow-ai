// Entry point. Loads .env first, then imports the app so config sees the variables.
import { loadEnvFile } from './src/env.js';

loadEnvFile();
const { startServer } = await import('./src/app.js');
await startServer();
