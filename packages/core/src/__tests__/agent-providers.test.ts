import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDeepDiveAgentProviders, buildDeepDiveAgentRateLimiters } from '../agent/providers';

const ENV_VARS = ['GROQ_DEEP_DIVE_AGENT_API_KEY', 'OPENROUTER_API_KEY'];

describe('buildDeepDiveAgentProviders', () => {
  const originals = new Map(ENV_VARS.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    ENV_VARS.forEach((name) => delete process.env[name]);
  });

  afterEach(() => {
    ENV_VARS.forEach((name) => {
      const original = originals.get(name);

      if (original !== undefined) {
        process.env[name] = original;
      } else {
        delete process.env[name];
      }
    });
  });

  it('routes Groq first, then OpenRouter, with no further fallback after it (no Gemini)', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = buildDeepDiveAgentProviders();

    expect(providers.reasoningProviders.map((provider) => provider.name)).toEqual(['groq', 'openrouter']);
  });

  it('reasoning and synthesis share the exact same provider list', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = buildDeepDiveAgentProviders();

    expect(providers.reasoningProviders).toBe(providers.synthesisProviders);
  });

  it('omits Groq entirely when its key is not set, keeping only OpenRouter', () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = buildDeepDiveAgentProviders();

    expect(providers.reasoningProviders.map((provider) => provider.name)).toEqual(['openrouter']);
  });

  it('never includes Gemini, even when GEMINI_API_KEY is set in the environment', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'groq-key';
    process.env.GEMINI_API_KEY = 'gemini-key';

    const providers = buildDeepDiveAgentProviders();

    expect(providers.reasoningProviders.map((provider) => provider.name)).not.toContain('gemini');

    delete process.env.GEMINI_API_KEY;
  });

  it('returns an empty provider list when nothing is configured at all', () => {
    const providers = buildDeepDiveAgentProviders();

    expect(providers.reasoningProviders).toEqual([]);
  });
});

describe('buildDeepDiveAgentRateLimiters', () => {
  it('builds a limiter for both groq and openrouter', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = buildDeepDiveAgentProviders();
    const rateLimiters = buildDeepDiveAgentRateLimiters(providers);

    expect(rateLimiters.has('groq')).toBe(true);
    expect(rateLimiters.has('openrouter')).toBe(true);

    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("overrides Groq's tpm to the 70b model's real ceiling (12000), not the shared conservative 8b-sized value (6000)", () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = buildDeepDiveAgentProviders();
    const rateLimiters = buildDeepDiveAgentRateLimiters(providers);

    expect(rateLimiters.get('groq')?.tpm).toBe(12_000);

    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
});
