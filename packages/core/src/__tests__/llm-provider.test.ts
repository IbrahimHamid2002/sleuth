import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeatBus } from '../llm/heartbeat-bus';
import type { LLMProvider } from '../llm/provider';
import { callWithFallback, createProviderChain, GroqProvider, OpenRouterProvider } from '../llm/provider';
import {
  buildRateLimitersForProviders,
  PROVIDER_RATE_LIMITS,
  RateLimitEscalationError,
  TokenBucketRateLimiter,
} from '../llm/rate-limiter';

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

  // Regression test for the Deep Dive agent's empty-first-response bug: the
  // root cause was that a "successful" HTTP response with empty completion
  // text (content: '') passed the old `content === undefined` check and was
  // returned as if it were a real answer — silently, with nothing downstream
  // (the full ReAct loop's synthesis step in particular) ever validating it
  // was non-empty. Every provider must now treat blank content the same as
  // missing content: a thrown error, not a quiet "success".
  it('treats an empty (but present) completion string as a failure, not a successful blank response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');

    await expect(provider.complete('prompt', { maxTokens: 100, temperature: 0.5 })).rejects.toThrow(
      /no completion content/,
    );
  });

  it('treats a whitespace-only completion the same as an empty one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '   \n  ' } }] }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new GroqProvider('test-groq-key', 'llama-3.1-8b-instant');

    await expect(provider.complete('prompt', { maxTokens: 100, temperature: 0.5 })).rejects.toThrow(
      /no completion content/,
    );
  });

  it('caps an unreasonably large retry-after (e.g. a real daily-quota-exceeded response) instead of waiting the literal duration', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          // A real quota-exhausted response can carry a retry-after of hours.
          headers: { 'retry-after': '7200' },
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

    // The literal 7200s (2 hours) never elapses — only the capped wait does.
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toBe('hello from groq');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(warnSpy).toHaveBeenCalledWith(
      '[LLM Fallback] Provider "groq" failed (groq: request failed with HTTP 429) — trying the next provider',
    );
  });

  // TASK 22B: exercises the real 3-link synthesis-stage chain (Groq ->
  // OpenRouter -> Gemini, per CLAUDE.md §1) end to end, proving
  // callWithFallback actually invokes OpenRouter as a genuine second attempt
  // and returns ITS response — not a fallback marker — when Groq fails.
  it('returns OpenRouter\'s actual response (not a fallback marker) when Groq fails and OpenRouter succeeds, in the real Groq -> OpenRouter -> Gemini chain', async () => {
    const groqComplete = vi.fn().mockRejectedValue(new Error('groq: request failed with HTTP 429'));
    const groq: LLMProvider = { name: 'groq', complete: groqComplete };
    const openrouterComplete = vi.fn().mockResolvedValue('a real openrouter-generated document');
    const openrouter: LLMProvider = { name: 'openrouter', complete: openrouterComplete };
    const geminiComplete = vi.fn().mockResolvedValue('gemini answer');
    const gemini: LLMProvider = { name: 'gemini', complete: geminiComplete };

    const result = await callWithFallback(
      [groq, openrouter, gemini],
      'prompt',
      { maxTokens: 100, temperature: 0.5 },
      new Map(),
    );

    expect(result).toBe('a real openrouter-generated document');
    expect(groqComplete).toHaveBeenCalledTimes(1);
    expect(openrouterComplete).toHaveBeenCalledTimes(1);
    // Gemini is the FINAL fallback — it must never be reached once OpenRouter
    // (the middle link) already succeeded.
    expect(geminiComplete).toHaveBeenCalledTimes(0);
  });

  it('falls all the way to Gemini when both Groq and OpenRouter fail, in the real Groq -> OpenRouter -> Gemini chain', async () => {
    const groq: LLMProvider = { name: 'groq', complete: vi.fn().mockRejectedValue(new Error('groq down')) };
    const openrouter: LLMProvider = {
      name: 'openrouter',
      complete: vi.fn().mockRejectedValue(new Error('openrouter down')),
    };
    const geminiComplete = vi.fn().mockResolvedValue('gemini-generated document');
    const gemini: LLMProvider = { name: 'gemini', complete: geminiComplete };

    const result = await callWithFallback(
      [groq, openrouter, gemini],
      'prompt',
      { maxTokens: 100, temperature: 0.5 },
      new Map(),
    );

    expect(result).toBe('gemini-generated document');
    expect(geminiComplete).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clear error — never a silent fake success — when Groq, OpenRouter, and Gemini all fail', async () => {
    const groq: LLMProvider = { name: 'groq', complete: vi.fn().mockRejectedValue(new Error('groq down')) };
    const openrouter: LLMProvider = {
      name: 'openrouter',
      complete: vi.fn().mockRejectedValue(new Error('openrouter down')),
    };
    const gemini: LLMProvider = { name: 'gemini', complete: vi.fn().mockRejectedValue(new Error('gemini down')) };

    await expect(
      callWithFallback([groq, openrouter, gemini], 'prompt', { maxTokens: 100, temperature: 0.5 }, new Map()),
    ).rejects.toThrow(/groq.*groq down.*openrouter.*openrouter down.*gemini.*gemini down/s);
  });

  // Regression test for the Deep Dive agent's empty-first-response bug: an
  // empty (but not thrown/rejected) completion from the first provider must
  // still trigger fallback to the next one — since GroqProvider/
  // OpenRouterProvider/GeminiProvider all now reject on blank content (see
  // llm-provider.test.ts's provider-level tests above), this is the
  // integration point that actually prevents a blank string from silently
  // reaching the caller in the real fallback chain.
  it('falls through to the next provider when the first "succeeds" with an empty completion', async () => {
    const emptyProvider: LLMProvider = { name: 'groq', complete: vi.fn().mockResolvedValue('') };
    const realAnswerProvider: LLMProvider = { name: 'openrouter', complete: vi.fn().mockResolvedValue('a real answer') };

    // Mirrors what GroqProvider.complete() itself now does for blank content
    // — callWithFallback only ever sees the rejection, not the raw HTTP
    // response, so simulating it at this level is the correct boundary.
    emptyProvider.complete = vi.fn().mockRejectedValue(new Error('groq returned no completion content'));

    const result = await callWithFallback(
      [emptyProvider, realAnswerProvider],
      'prompt',
      { maxTokens: 100, temperature: 0.5 },
      new Map(),
    );

    expect(result).toBe('a real answer');
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

  it('delays waitForBudget until the request-permit bucket refills when empty', async () => {
    vi.useFakeTimers();

    // hardWaitTimeoutMs raised past this test's ~61s wait — this test is
    // exercising request-permit refill timing, not the hard-timeout escalation.
    const limiter = new TokenBucketRateLimiter(1, null, 120_000); // 1 request/minute, no TPM cap

    await limiter.waitForBudget(0);

    let resolved = false;
    const waitPromise = limiter.waitForBudget(0).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('delays waitForBudget until the token budget refills, even when request permits are available', async () => {
    vi.useFakeTimers();

    // hardWaitTimeoutMs raised past this test's ~35s wait — this test is
    // exercising token-budget refill timing, not the hard-timeout escalation.
    const limiter = new TokenBucketRateLimiter(1000, 60, 60_000); // generous RPM, 60 tokens/minute (1/sec refill)

    await limiter.waitForBudget(60); // drains the entire token budget in one call

    let resolved = false;
    const waitPromise = limiter.waitForBudget(30).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(20_000); // only ~20 tokens refilled so far
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000); // ~35 tokens available now
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('never blocks on token budget when tpm is null (not yet verified for this provider)', async () => {
    const limiter = new TokenBucketRateLimiter(10, null);

    await expect(limiter.waitForBudget(999_999)).resolves.toBeUndefined();
  });

  it('escape hatch: a single request whose estimate exceeds tpm resolves once the bucket is fully refilled, instead of hanging forever', async () => {
    vi.useFakeTimers();

    // hardWaitTimeoutMs raised well past this test's ~20s refill wait — this
    // test is exercising the refill/debt mechanism, not the timeout.
    const limiter = new TokenBucketRateLimiter(1000, 100, 60_000); // generous RPM, 100 tokens/minute (~1.667/sec)

    await limiter.waitForBudget(30); // partially drains the bucket: 100 -> 70

    let resolved = false;
    // 500 > tpm (100) — the normal "tokenBudget >= estimatedTokens" check can
    // never be satisfied (tokenBudget never exceeds 100), so this must use
    // the escape hatch (wait for full refill to 100, then admit) rather than
    // spin forever — this reproduces the real deadlock a synthesis-stage
    // call hit in production (its estimate routinely exceeds Groq's tpm).
    const waitPromise = limiter.waitForBudget(500).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10_000); // only partially refilled (70 -> ~87), not yet full
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000); // now fully refilled (>= 100)
    await waitPromise;
    expect(resolved).toBe(true);
  });

  it('escape hatch resolves immediately when the bucket already starts full', async () => {
    const limiter = new TokenBucketRateLimiter(1000, 100);

    // Bucket starts at its max (100) — an oversized request should be
    // admitted right away, not forced to wait for a refill it doesn't need.
    await expect(limiter.waitForBudget(500)).resolves.toBeUndefined();
  });

  it('debt path: overflow from an oversized admission is repaid from future refills before any new tokens become visible', async () => {
    vi.useFakeTimers();

    const limiter = new TokenBucketRateLimiter(1000, 100, 60_000); // 100 tokens/minute (~1.667/sec)

    // Bucket starts full (100/100) so this resolves immediately: 250 - 100 =
    // 150 tracked as debt, visible budget floored to 0.
    await limiter.waitForBudget(250);

    // A full minute of refill (100 tokens' worth) goes entirely toward
    // repaying the 150 debt — none of it should become visible yet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limiter.snapshotHeadroom(0).tokenHeadroom).toBe(0);

    // Another 30s (~50 tokens) exactly clears the remaining 50 debt — still
    // nothing visible.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(limiter.snapshotHeadroom(0).tokenHeadroom).toBe(0);

    // Debt is now fully repaid — further refill finally credits visible budget.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(limiter.snapshotHeadroom(0).tokenHeadroom).toBeGreaterThan(0);
  });

  it('throws a RateLimitEscalationError (with waitedMs/estimatedTokens/accountId) once hardWaitTimeoutMs elapses without securing budget', async () => {
    vi.useFakeTimers();

    // 1 request/minute means a second request permit takes ~60s to refill —
    // comfortably past the 5s hardWaitTimeoutMs configured here.
    const limiter = new TokenBucketRateLimiter(1, null, 5_000, 'test-account');

    await limiter.waitForBudget(0); // drains the sole request permit

    let caught: unknown;
    const waitPromise = limiter.waitForBudget(0).catch((err: unknown) => {
      caught = err;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitPromise;

    expect(caught).toBeInstanceOf(RateLimitEscalationError);

    const error = caught as RateLimitEscalationError;

    expect(error.accountId).toBe('test-account');
    expect(error.estimatedTokens).toBe(0);
    expect(error.waitedMs).toBeGreaterThanOrEqual(5_000);
  });

  it('pulses the heartbeat bus on every poll tick while waiting', async () => {
    vi.useFakeTimers();

    const pulses: string[] = [];
    const listener = (event: { source: string }): void => {
      pulses.push(event.source);
    };

    heartbeatBus.on('pulse', listener);

    try {
      const limiter = new TokenBucketRateLimiter(1, null, 10_000, 'pulse-test');

      await limiter.waitForBudget(0); // drains the sole request permit, pulses once

      const waitPromise = limiter.waitForBudget(0);
      // Set up the rejection assertion before advancing further timers, so
      // nothing is awaited while the fake clock is idle.
      const rejection = expect(waitPromise).rejects.toThrow(RateLimitEscalationError);

      await vi.advanceTimersByTimeAsync(9_000);

      expect(pulses.filter((source) => source === 'rate-limiter').length).toBeGreaterThan(1);

      // Let it finish (throws past hardWaitTimeoutMs) so the test doesn't
      // leave a dangling timer.
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      heartbeatBus.off('pulse', listener);
    }
  });

  it('aborts immediately when the given signal fires, well before hardWaitTimeoutMs would otherwise elapse', async () => {
    vi.useFakeTimers();

    // hardWaitTimeoutMs is a generous 60s here specifically to prove the
    // abort is what ends the wait, not the timeout racing it.
    const limiter = new TokenBucketRateLimiter(1, null, 60_000, 'abort-test');

    await limiter.waitForBudget(0); // drains the sole request permit

    const controller = new AbortController();
    const waitPromise = limiter.waitForBudget(0, controller.signal);
    const rejection = expect(waitPromise).rejects.toThrow(/aborted/i);

    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
  });
});

describe('PROVIDER_RATE_LIMITS', () => {
  it('has a known, deliberate shape — a change here should be a conscious edit, not a silent regression', () => {
    expect(PROVIDER_RATE_LIMITS.groq).toEqual({ rpm: 28, tpm: 6000 });
    expect(PROVIDER_RATE_LIMITS.gemini).toEqual({ rpm: 13, tpm: null });
    // tpm is deliberately null — OpenRouter doesn't publish a tokens/minute
    // ceiling, and guessing one risks the exact "isOversized" false-positive
    // regression this session's rate-limiter fix addressed for other providers.
    expect(PROVIDER_RATE_LIMITS.openrouter).toEqual({ rpm: 20, tpm: null });
  });
});

describe('buildRateLimitersForProviders', () => {
  it('builds a limiter for every provider with a known rpm, and skips one with no PROVIDER_RATE_LIMITS entry at all', () => {
    const groq: LLMProvider = { name: 'groq', complete: vi.fn() };
    const gemini: LLMProvider = { name: 'gemini', complete: vi.fn() };
    // Not a real provider name in PROVIDER_RATE_LIMITS — stands in for
    // "no known ceiling yet" without depending on openrouter's specific
    // current values (which are expected to change once live-verified).
    const unknownProvider: LLMProvider = { name: 'some-unconfigured-provider', complete: vi.fn() };

    const rateLimiters = buildRateLimitersForProviders([groq, gemini, unknownProvider]);

    expect(rateLimiters.has('groq')).toBe(true);
    expect(rateLimiters.has('gemini')).toBe(true);
    expect(rateLimiters.has('some-unconfigured-provider')).toBe(false);
  });
});

describe('OpenRouterProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('completes successfully against the OpenAI-compatible chat completions shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'hello from openrouter' } }] }), { status: 200 }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenRouterProvider('test-openrouter-key', 'test/model:free');
    const result = await provider.complete('prompt', { maxTokens: 100, temperature: 0.5 });

    expect(result).toBe('hello from openrouter');
  });

  it('throws when constructed with an empty API key', () => {
    expect(() => new OpenRouterProvider('', 'test/model:free')).toThrow(/non-empty API key/);
  });

  it('treats an empty completion string as a failure, not a successful blank response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenRouterProvider('test-openrouter-key', 'test/model:free');

    await expect(provider.complete('prompt', { maxTokens: 100, temperature: 0.5 })).rejects.toThrow(
      /no completion content/,
    );
  });
});

describe('createProviderChain', () => {
  const originalAgentKey = process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = originalAgentKey;
    process.env.GEMINI_API_KEY = originalGeminiKey;
    process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  });

  it('builds a Groq provider using the given env var and model', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('groq');
  });

  it('skips Groq (warns, does not throw) when the configured env var is missing', () => {
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });

    expect(providers).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('GROQ_DEEP_DIVE_AGENT_API_KEY is not set — skipping Groq provider');

    warnSpy.mockRestore();
  });

  it('includes Gemini via the default GEMINI_API_KEY env var when geminiApiKeyEnvVar is not given', () => {
    delete process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-key';
    delete process.env.OPENROUTER_API_KEY;

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe('gemini');
  });

  it('includes OpenRouter via the default OPENROUTER_API_KEY env var, ordered between Groq and Gemini', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });

    expect(providers.map((provider) => provider.name)).toEqual(['groq', 'openrouter', 'gemini']);
  });

  it('skips OpenRouter (warns, does not throw) when OPENROUTER_API_KEY is missing', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    // Not asserting the specific warn message here: warnMissingEnvVarOnce
    // dedupes per env-var name for the lifetime of the module (see
    // provider.ts), and an earlier test in this file already triggers the
    // real "OPENROUTER_API_KEY is not set" warning once — asserting it again
    // here would be order-dependent. The behavior that actually matters
    // (OpenRouter is skipped, not thrown) is still verified below.
    const providers = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });

    expect(providers.map((provider) => provider.name)).toEqual(['groq']);
  });

  it('two configs reading the same Groq env var with different models both build independently', () => {
    process.env.GROQ_DEEP_DIVE_AGENT_API_KEY = 'agent-key';
    delete process.env.GEMINI_API_KEY;
    // Explicit delete rather than relying on afterEach's reset: Node coerces
    // `process.env.X = undefined` to the literal string "undefined" (not a
    // real delete), so if OPENROUTER_API_KEY was ever unset-at-suite-start,
    // afterEach's "restore to original" can leave a truthy stale value here.
    delete process.env.OPENROUTER_API_KEY;

    const reasoning = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.1-8b-instant',
      openrouterModel: 'test/model:free',
    });
    const synthesis = createProviderChain({
      groqApiKeyEnvVar: 'GROQ_DEEP_DIVE_AGENT_API_KEY',
      groqModel: 'llama-3.3-70b-versatile',
      openrouterModel: 'test/model:free',
    });

    expect(reasoning).toHaveLength(1);
    expect(synthesis).toHaveLength(1);
  });
});
