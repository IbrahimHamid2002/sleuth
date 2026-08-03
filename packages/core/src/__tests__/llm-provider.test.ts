import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider } from '../llm/provider';
import { callWithFallback, createProviderChain, GroqProvider } from '../llm/provider';
import { TokenBucketRateLimiter } from '../llm/rate-limiter';

describe('GroqProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const resultPromise = provider.complete('prompt', { maxTokens: 100, temperature: 0.5 });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toBe('hello from groq');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when constructed with an empty API key', () => {
    expect(() => new GroqProvider('', 'llama-3.1-8b-instant')).toThrow(/non-empty API key/);
  });

  it('retries up to 3 times on repeated 429 responses before succeeding, not just once', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hello from groq' } }] }), { status: 200 }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const resultPromise = provider.complete('prompt', { maxTokens: 100, temperature: 0.5 });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(resultPromise).resolves.toBe('hello from groq');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('gives up after exhausting all 3 rate-limit retries and throws', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const resultPromise = provider.complete('prompt', { maxTokens: 100, temperature: 0.5 });
    const assertion = expect(resultPromise).rejects.toThrow(/HTTP 429/);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects immediately without calling fetch when the signal is already aborted', async () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const controller = new AbortController();

    controller.abort();

    await expect(
      provider.complete('prompt', { maxTokens: 100, temperature: 0.5 }, controller.signal),
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interrupts a retry-after wait when the signal aborts mid-wait, without a second fetch attempt', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const controller = new AbortController();
    const resultPromise = provider.complete('prompt', { maxTokens: 100, temperature: 0.5 }, controller.signal);
    const assertion = expect(resultPromise).rejects.toThrow(/aborted/i);

    await vi.advanceTimersByTimeAsync(2000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
    // Only the first attempt happened — the 30s retry-after wait never ran to
    // completion, proving the deadline actually interrupted it instead of the
    // request continuing to consume free-tier quota in the background.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('callWithFallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  it('never calls Gemini when Groq succeeds on the first attempt', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'groq answer' } }] }), { status: 200 }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const groq = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const geminiComplete = vi.fn().mockResolvedValue('gemini answer');
    const gemini: LLMProvider = { name: 'gemini', complete: geminiComplete };

    const result = await callWithFallback([groq, gemini], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map());

    expect(result).toBe('groq answer');
    expect(geminiComplete).toHaveBeenCalledTimes(0);
    expect(warnSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never calls Gemini when Groq succeeds only after its own internal 429 retry', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'groq answer after retry' } }] }), {
          status: 200,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const groq = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');
    const geminiComplete = vi.fn().mockResolvedValue('gemini answer');
    const gemini: LLMProvider = { name: 'gemini', complete: geminiComplete };

    const resultPromise = callWithFallback([groq, gemini], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map());

    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;

    expect(result).toBe('groq answer after retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(geminiComplete).toHaveBeenCalledTimes(0);
    expect(warnSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calls Gemini exactly once, and returns its result, when Groq throws after exhausting its own retries', async () => {
    const groqComplete = vi.fn().mockRejectedValue(new Error('groq: request failed with HTTP 429'));
    const groq: LLMProvider = { name: 'groq', complete: groqComplete };
    const geminiComplete = vi.fn().mockResolvedValue('gemini answer');
    const gemini: LLMProvider = { name: 'gemini', complete: geminiComplete };

    const result = await callWithFallback([groq, gemini], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map());

    expect(result).toBe('gemini answer');
    expect(groqComplete).toHaveBeenCalledTimes(1);
    expect(geminiComplete).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[LLM Fallback] Provider "groq" failed, attempting "gemini"');
  });

  it('throws a final error mentioning both provider names/failure reasons when both throw', async () => {
    const groq: LLMProvider = { name: 'groq', complete: vi.fn().mockRejectedValue(new Error('groq down')) };
    const gemini: LLMProvider = { name: 'gemini', complete: vi.fn().mockRejectedValue(new Error('gemini down')) };

    await expect(
      callWithFallback([groq, gemini], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map()),
    ).rejects.toThrow(/groq.*groq down.*gemini.*gemini down/s);
  });

  it('skips every provider and calls none of them once the signal is already aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    const p1: LLMProvider = { name: 'p1', complete: vi.fn().mockResolvedValue('p1 answer') };
    const p2: LLMProvider = { name: 'p2', complete: vi.fn().mockResolvedValue('p2 answer') };

    await expect(
      callWithFallback([p1, p2], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map(), controller.signal),
    ).rejects.toThrow(/deadline already exceeded/i);
    expect(p1.complete).not.toHaveBeenCalled();
    expect(p2.complete).not.toHaveBeenCalled();
  });

  it('forwards the signal through to provider.complete', async () => {
    const controller = new AbortController();
    const completeMock = vi.fn().mockResolvedValue('answer');
    const provider: LLMProvider = { name: 'p1', complete: completeMock };

    await callWithFallback([provider], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map(), controller.signal);

    expect(completeMock).toHaveBeenCalledWith('prompt', { maxTokens: 100, temperature: 0.5 }, controller.signal);
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
  const originalAgentKey = process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = originalAgentKey;
    process.env.GEMINI_API_KEY = originalGeminiKey;
  });

  it('builds a Groq provider using the given env var and model', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    delete process.env.GEMINI_API_KEY;

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('groq');
  });

  it('skips Groq (warns, does not throw) when the configured env var is missing', () => {
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
    });

    expect(providers).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('GROQ_DEEP_DIVE_AGENT_API_KEY is not set — skipping Groq provider');

    warnSpy.mockRestore();
  });

  it('includes Gemini via the default GEMINI_API_KEY env var when geminiApiKeyEnvVar is not given', () => {
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key';

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('gemini');
  });

  it('two configs reading the same Groq env var with different models both build independently', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    delete process.env.GEMINI_API_KEY;

    const reasoning = createProviderChain({ groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY', groqModel: 'llama-3.1-8b-instant' });
    const synthesis = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.3-70b-versatile',
    });

    expect(reasoning).toHaveLength(1);
    expect(synthesis).toHaveLength(1);
  });
});
