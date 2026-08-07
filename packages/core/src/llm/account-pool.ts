import type { LLMProvider, PooledAccount } from '../types';

import { estimateTokenCost, GroqProvider, warnMissingEnvVarOnce } from './provider';
import { PROVIDER_RATE_LIMITS, TokenBucketRateLimiter } from './rate-limiter';

export type { PooledAccount } from '../types';

// Wraps N independently-rate-limited "accounts" (e.g. two Groq API keys, each
// with its own real RPM/TPM ceiling) behind the ordinary LLMProvider
// interface, so callWithFallback's fallback chain can treat a whole pool as
// one more provider link. `complete()` picks whichever account currently has
// the MOST headroom (never round-robin), waits on that one, then delegates.
export class AccountPool implements LLMProvider {
  readonly name: string;
  private readonly accounts: PooledAccount[];
  private readonly maxWaitMs: number | undefined;

  // `maxWaitMs`, when given, bounds how long `complete()` queues on this pool:
  // past it, throws instead of waiting, so a caller's own fallback chain can
  // take over immediately. Omit it to queue indefinitely (background/batch use).
  constructor(name: string, accounts: PooledAccount[], maxWaitMs?: number) {
    if (accounts.length === 0) {
      throw new Error(`AccountPool "${name}" requires at least one account`);
    }

    this.name = name;
    this.accounts = accounts;
    this.maxWaitMs = maxWaitMs;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string> {
    const estimatedTokens = estimateTokenCost(prompt, opts.maxTokens);
    const account = await this.selectAccount(estimatedTokens);

    return account.provider.complete(prompt, opts, signal);
  }

  // Selection strategy: (1) any account with headroom right now, picking the
  // most headroom among those; (2) none ready, but at least one account could
  // eventually fit — wait for whichever is soonest; (3) the estimate exceeds
  // every account's own tpm — force through the largest account's escape
  // hatch (see TokenBucketRateLimiter.waitForBudget), since it wastes least.
  private async selectAccount(estimatedTokens: number): Promise<PooledAccount> {
    const capable = this.accounts.filter((account) => account.limiter.tpm === null || account.limiter.tpm >= estimatedTokens);

    if (capable.length === 0) {
      const largest = this.accounts.reduce((best, account) =>
        (account.limiter.tpm ?? Number.POSITIVE_INFINITY) > (best.limiter.tpm ?? Number.POSITIVE_INFINITY) ? account : best,
      );
      const snapshot = largest.limiter.snapshotHeadroom(estimatedTokens);

      this.assertWithinMaxWait(snapshot.msUntilReady);
      await largest.limiter.waitForBudget(estimatedTokens);

      return largest;
    }

    const snapshots = capable.map((account) => ({ account, snapshot: account.limiter.snapshotHeadroom(estimatedTokens) }));
    const ready = snapshots.filter((entry) => entry.snapshot.ready);

    if (ready.length > 0) {
      ready.sort(
        (a, b) => b.snapshot.tokenHeadroom - a.snapshot.tokenHeadroom || b.snapshot.requestHeadroom - a.snapshot.requestHeadroom,
      );

      const chosen = ready[0]!.account;

      await chosen.limiter.waitForBudget(estimatedTokens);

      return chosen;
    }

    snapshots.sort((a, b) => a.snapshot.msUntilReady - b.snapshot.msUntilReady);

    const soonest = snapshots[0]!;

    this.assertWithinMaxWait(soonest.snapshot.msUntilReady);
    await soonest.account.limiter.waitForBudget(estimatedTokens);

    return soonest.account;
  }

  private assertWithinMaxWait(msUntilReady: number): void {
    if (this.maxWaitMs !== undefined && msUntilReady > this.maxWaitMs) {
      throw new Error(
        `AccountPool "${this.name}" is rate-limited across all ${this.accounts.length} account(s) — soonest available in ${Math.ceil(msUntilReady / 1000)}s, past this pool's ${Math.ceil(this.maxWaitMs / 1000)}s max wait`,
      );
    }
  }
}

// Builds a pooled Groq provider from a list of env var names, one account per
// var — skips (warns, doesn't throw) any that aren't set. Reuses
// PROVIDER_RATE_LIMITS.groq's numbers as a conservative placeholder for every
// account; confirm each account's real rate-limit headers before trusting
// this under load rather than assuming they're identical.
export function createGroqAccountPool(apiKeyEnvVars: string[], model: string, maxWaitMs?: number): AccountPool | undefined {
  const limits = PROVIDER_RATE_LIMITS.groq;
  const pooled: PooledAccount[] = [];

  for (const envVar of apiKeyEnvVars) {
    const apiKey = process.env[envVar];

    if (apiKey === undefined) {
      warnMissingEnvVarOnce(envVar, 'Groq account');
      continue;
    }

    pooled.push({
      provider: new GroqProvider(apiKey, model),
      limiter: new TokenBucketRateLimiter(limits?.rpm ?? 28, limits?.tpm ?? null, undefined, envVar),
    });
  }

  if (pooled.length === 0) {
    return undefined;
  }

  return new AccountPool('groq', pooled, maxWaitMs);
}
