import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountPool, createGroqAccountPool } from '../llm/account-pool';
import type { LLMProvider } from '../llm/provider';
import { TokenBucketRateLimiter } from '../llm/rate-limiter';

function fakeProvider(name: string, answer: string): LLMProvider {
  return { name, complete: vi.fn().mockResolvedValue(answer) };
}

describe('AccountPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks the account with the MOST current headroom, not round-robin', async () => {
    const depletedProvider = fakeProvider('groq', 'from depleted account');
    const freshProvider = fakeProvider('groq', 'from fresh account');

    const depletedLimiter = new TokenBucketRateLimiter(1000, 1000);
    const freshLimiter = new TokenBucketRateLimiter(1000, 1000);

    // Drain most of the first account's token budget so the second one has
    // far more headroom for the next request, even though it's listed first.
    await depletedLimiter.waitForBudget(900);

    const pool = new AccountPool('groq', [
      { provider: depletedProvider, limiter: depletedLimiter },
      { provider: freshProvider, limiter: freshLimiter },
    ]);

    const result = await pool.complete('prompt', { maxTokens: 10, temperature: 0.2 });

    expect(result).toBe('from fresh account');
    expect(freshProvider.complete).toHaveBeenCalledTimes(1);
    expect(depletedProvider.complete).not.toHaveBeenCalled();
  });

  it('waits for whichever account will be ready soonest when none have room right now', async () => {
    vi.useFakeTimers();

    const slowToRefillProvider = fakeProvider('groq', 'from slow account');
    const fastToRefillProvider = fakeProvider('groq', 'from fast account');

    // Both start fully drained; the second refills much faster (higher tpm),
    // so it should become ready first even though both start at 0.
    const slowLimiter = new TokenBucketRateLimiter(1000, 60); // 1 token/sec
    const fastLimiter = new TokenBucketRateLimiter(1000, 600); // 10 tokens/sec

    await slowLimiter.waitForBudget(60);
    await fastLimiter.waitForBudget(600);

    const pool = new AccountPool('groq', [
      { provider: slowToRefillProvider, limiter: slowLimiter },
      { provider: fastToRefillProvider, limiter: fastLimiter },
    ]);

    const resultPromise = pool.complete('prompt', { maxTokens: 10, temperature: 0.2 });

    await vi.advanceTimersByTimeAsync(30_000);

    const result = await resultPromise;

    expect(result).toBe('from fast account');
    expect(fastToRefillProvider.complete).toHaveBeenCalledTimes(1);
    expect(slowToRefillProvider.complete).not.toHaveBeenCalled();
  });

  it('escape hatch: when the estimate exceeds every account\'s own tpm, uses whichever has the LARGEST tpm', async () => {
    const smallCapProvider = fakeProvider('groq', 'from small-cap account');
    const largeCapProvider = fakeProvider('groq', 'from large-cap account');

    const smallCapLimiter = new TokenBucketRateLimiter(1000, 100);
    const largeCapLimiter = new TokenBucketRateLimiter(1000, 500);

    const pool = new AccountPool('groq', [
      { provider: smallCapProvider, limiter: smallCapLimiter },
      { provider: largeCapProvider, limiter: largeCapLimiter },
    ]);

    // maxTokens alone (4000) forces estimatedTokens well above both
    // accounts' tpm ceilings (100 and 500).
    const result = await pool.complete('short prompt', { maxTokens: 4000, temperature: 0.2 });

    expect(result).toBe('from large-cap account');
    expect(largeCapProvider.complete).toHaveBeenCalledTimes(1);
    expect(smallCapProvider.complete).not.toHaveBeenCalled();
  });

  it('throws when constructed with zero accounts', () => {
    expect(() => new AccountPool('groq', [])).toThrow(/at least one account/);
  });

  it('throws instead of waiting once every account is rate-limited past maxWaitMs, so a caller can fail over immediately', async () => {
    const provider = fakeProvider('groq', 'should never be reached');
    const limiter = new TokenBucketRateLimiter(1000, 60); // 1 token/sec refill

    await limiter.waitForBudget(60); // fully drains it — next request needs a real wait

    // Soonest refill for 60 tokens back is ~60s away; a 5s max wait must
    // reject rather than actually wait that long.
    const pool = new AccountPool('groq', [{ provider, limiter }], 5_000);

    await expect(pool.complete('prompt', { maxTokens: 10, temperature: 0.2 })).rejects.toThrow(/rate-limited across all/);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('waits (does not throw) when no maxWaitMs is configured, even for a long wait', async () => {
    vi.useFakeTimers();

    const provider = fakeProvider('groq', 'answer after waiting');
    const limiter = new TokenBucketRateLimiter(1000, 60);

    await limiter.waitForBudget(60);

    const pool = new AccountPool('groq', [{ provider, limiter }]); // no maxWaitMs

    const resultPromise = pool.complete('prompt', { maxTokens: 10, temperature: 0.2 });

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(resultPromise).resolves.toBe('answer after waiting');
  });
});

describe('createGroqAccountPool', () => {
  const envVars = ['TEST_GROQ_ACCOUNT_1', 'TEST_GROQ_ACCOUNT_2'];
  const originals = envVars.map((name) => process.env[name]);

  afterEach(() => {
    envVars.forEach((name, index) => {
      const original = originals[index];

      if (original !== undefined) {
        process.env[name] = original;
      } else {
        delete process.env[name];
      }
    });
  });

  it('builds a pool with one account per set env var, skipping missing ones', () => {
    process.env.TEST_GROQ_ACCOUNT_1 = 'key-1';
    delete process.env.TEST_GROQ_ACCOUNT_2;

    const pool = createGroqAccountPool(envVars, 'llama-3.3-70b-versatile');

    expect(pool).toBeDefined();
    expect(pool?.name).toBe('groq');
  });

  it('returns undefined when none of the account env vars are set', () => {
    delete process.env.TEST_GROQ_ACCOUNT_1;
    delete process.env.TEST_GROQ_ACCOUNT_2;

    const pool = createGroqAccountPool(envVars, 'llama-3.3-70b-versatile');

    expect(pool).toBeUndefined();
  });
});
