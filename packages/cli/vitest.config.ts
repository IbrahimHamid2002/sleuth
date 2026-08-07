import { defineConfig } from 'vitest/config';

// analyze.e2e.test.ts makes real network/LLM calls (clone + Groq/OpenRouter/
// Gemini) and can take several minutes — it self-skips without live API keys
// (see its hasLiveKeys check) but must still be excluded from the default
// `npm test` run so a plain test run stays fast even when a local .env does
// have keys configured. Run it explicitly via `npm run test:e2e`.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', 'src/__tests__/analyze.e2e.test.ts'],
  },
});
