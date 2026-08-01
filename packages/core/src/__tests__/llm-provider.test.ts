import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider } from '../llm/provider';
import { callWithFallback, createProviderChain, GroqProvider } from '../llm/provider';
import { TokenBucketRateLimiter } from '../llm/rate-limiter';

describe('GroqProvider', () => {
  const originalApiKey = process.env.GROQ_SUMMARIZER_API_KEY;

  beforeEach(() => {
    process.env.GROQ_SUMMARIZER_API_KEY = 'test-groq-key';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.GROQ_SUMMARIZER_API_KEY = originalApiKey;
  });

  it('retries once on a mocked 429 response, honoring retry-after', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hello from groq' } }] }), {
          status: 200,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('llama-3.1-8b-instant');
    const resultPromise = provider.complete('prompt', { maxTokens: 100, temperature: 0.5 });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toBe('hello from groq');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws GROQ_SUMMARIZER_API_KEY error when the key is missing at construction', () => {
    delete process.env.GROQ_SUMMARIZER_API_KEY;

    expect(() => new GroqProvider('llama-3.1-8b-instant')).toThrow('GROQ_SUMMARIZER_API_KEY is not set');
  });
});

describe('callWithFallback', () => {
  it('falls through to the second provider when the first throws', async () => {
    const failingProvider: LLMProvider = {
      name: 'p1',
      complete: vi.fn().mockRejectedValue(new Error('p1 exploded')),
    };
    const succeedingProvider: LLMProvider = {
      name: 'p2',
      complete: vi.fn().mockResolvedValue('p2 answer'),
    };

    const result = await callWithFallback(
      [failingProvider, succeedingProvider],
      'prompt',
      { maxTokens: 100, temperature: 0.5 },
      new Map(),
    );

    expect(result).toBe('p2 answer');
    expect(failingProvider.complete).toHaveBeenCalledTimes(1);
    expect(succeedingProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('throws a combined error when all providers fail', async () => {
    const p1: LLMProvider = { name: 'p1', complete: vi.fn().mockRejectedValue(new Error('p1 down')) };
    const p2: LLMProvider = { name: 'p2', complete: vi.fn().mockRejectedValue(new Error('p2 down')) };

    await expect(
      callWithFallback([p1, p2], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map()),
    ).rejects.toThrow(/p1 down.*p2 down/s);
  });
});

describe('TokenBucketRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays waitForToken until the bucket refills when empty', async () => {
    vi.useFakeTimers();

    const limiter = new TokenBucketRateLimiter(1, 1);

    await limiter.waitForToken();

    let resolved = false;
    const waitPromise = limiter.waitForToken().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    await waitPromise;
    expect(resolved).toBe(true);
  });
});

describe('createProviderChain', () => {
  const originalSummarizerKey = process.env.GROQ_SUMMARIZER_API_KEY;
  const originalSynthesizerKey = process.env.GROQ_SYNTHESIZER_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    process.env.GROQ_SUMMARIZER_API_KEY = originalSummarizerKey;
    process.env.GROQ_SYNTHESIZER_API_KEY = originalSynthesizerKey;
    process.env.GEMINI_API_KEY = originalGeminiKey;
  });

  it('defaults to the summarizer-flavored Groq provider when no role is given', () => {
    process.env.GROQ_SUMMARIZER_API_KEY = 'summarizer-key';
    delete process.env.GROQ_SYNTHESIZER_API_KEY;
    delete process.env.GEMINI_API_KEY;

    expect(createProviderChain()).toHaveLength(1);
  });

  it('builds a Groq provider from GROQ_SYNTHESIZER_API_KEY for the synthesizer role, independent of the summarizer key', () => {
    delete process.env.GROQ_SUMMARIZER_API_KEY;
    process.env.GROQ_SYNTHESIZER_API_KEY = 'synthesizer-key';
    delete process.env.GEMINI_API_KEY;

    expect(createProviderChain('synthesizer')).toHaveLength(1);
  });

  it('skips Groq for a role whose key is missing, even when the other role key is set', () => {
    process.env.GROQ_SUMMARIZER_API_KEY = 'summarizer-key';
    delete process.env.GROQ_SYNTHESIZER_API_KEY;
    delete process.env.GEMINI_API_KEY;

    expect(createProviderChain('synthesizer')).toHaveLength(0);
    expect(createProviderChain('summarizer')).toHaveLength(1);
  });
});
