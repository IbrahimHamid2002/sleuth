import { PROVIDER_RATE_LIMITS, RATE_LIMITER_POLL_JITTER_MS } from '../constants';
import type { HeadroomSnapshot, ProviderRateLimits } from '../types';

import { heartbeatBus } from './heartbeat-bus';
import type { LLMProvider } from './provider';

export { PROVIDER_RATE_LIMITS } from '../constants';
export type { HeadroomSnapshot, ProviderRateLimits } from '../types';

// Thrown by `waitForBudget` when a request's budget can't be secured within
// `hardWaitTimeoutMs` — a typed escalation instead of polling forever, so
// `callWithFallback` can fail over to the next provider immediately.
export class RateLimitEscalationError extends Error {
  constructor(
    message: string,
    readonly waitedMs: number,
    readonly estimatedTokens: number,
    readonly accountId: string,
  ) {
    super(message);
    this.name = 'RateLimitEscalationError';
  }
}

export class TokenBucketRateLimiter {
  private requestPermits: number;
  private lastRequestRefillAt: number;
  private tokenBudget: number;
  private lastTokenRefillAt: number;
  private readonly requestRefillPerSecond: number;
  private readonly tokenRefillPerSecond: number | null;
  // Tokens an oversized admission borrowed against future capacity (see
  // `isOversized`) that haven't been repaid yet — every refill pays this
  // down first, silently, before any of it becomes visible in `tokenBudget`.
  private debt = 0;

  constructor(
    readonly rpm: number,
    readonly tpm: number | null = null,
    // Bounds how long a single `waitForBudget` call polls before throwing
    // `RateLimitEscalationError`. Default is 65s: a full token-bucket refill
    // from empty always takes exactly 60s regardless of `tpm`, so any
    // oversized request can legitimately need up to that long once admitted
    // via the escape hatch — 65s gives a 5s margin over the worst case.
    readonly hardWaitTimeoutMs: number = 65_000,
    // Identifies this limiter in a thrown RateLimitEscalationError.
    readonly accountId: string = 'default',
  ) {
    this.requestRefillPerSecond = rpm / 60;
    this.requestPermits = rpm;
    this.lastRequestRefillAt = Date.now();

    this.tokenRefillPerSecond = tpm !== null ? tpm / 60 : null;
    this.tokenBudget = tpm ?? 0;
    this.lastTokenRefillAt = Date.now();
  }

  private refillRequests(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRequestRefillAt) / 1000;

    if (elapsedSeconds <= 0) {
      return;
    }

    this.requestPermits = Math.min(this.rpm, this.requestPermits + elapsedSeconds * this.requestRefillPerSecond);
    this.lastRequestRefillAt = now;
  }

  private refillTokenBudget(): void {
    if (this.tpm === null || this.tokenRefillPerSecond === null) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = (now - this.lastTokenRefillAt) / 1000;

    if (elapsedSeconds <= 0) {
      return;
    }

    let refillAmount = elapsedSeconds * this.tokenRefillPerSecond;

    if (this.debt > 0) {
      const repaid = Math.min(this.debt, refillAmount);

      this.debt -= repaid;
      refillAmount -= repaid;
    }

    this.tokenBudget = Math.min(this.tpm, this.tokenBudget + refillAmount);
    this.lastTokenRefillAt = now;
  }

  // A request whose own estimated cost exceeds this bucket's TPM ceiling can
  // never satisfy the normal `tokenBudget >= estimatedTokens` check, so the
  // caller would wait forever. Escape hatch: for an oversized request, treat
  // "bucket fully refilled" as readiness instead of "big enough for the
  // whole estimate," admit it, and floor the budget at 0 — this never
  // enlarges the bucket's capacity, it just lets one oversized request use
  // up more than it earned rather than deadlock.
  private isOversized(estimatedTokens: number): boolean {
    return this.tpm !== null && estimatedTokens > this.tpm;
  }

  // Non-blocking — refills first, then reports readiness/headroom for
  // `estimatedTokens` without consuming anything, so several buckets can be
  // compared back-to-back with no `await` between calls.
  snapshotHeadroom(estimatedTokens: number): HeadroomSnapshot {
    this.refillRequests();
    this.refillTokenBudget();

    const hasRequestPermit = this.requestPermits >= 1;
    const oversized = this.isOversized(estimatedTokens);
    const tokenTarget = this.tpm === null ? 0 : oversized ? this.tpm : estimatedTokens;
    const hasTokenBudget = this.tpm === null || this.tokenBudget >= tokenTarget;

    const requestWaitMs = hasRequestPermit
      ? 0
      : Math.ceil(((1 - this.requestPermits) / this.requestRefillPerSecond) * 1000);
    const tokenWaitMs =
      hasTokenBudget || this.tokenRefillPerSecond === null
        ? 0
        : Math.ceil(((tokenTarget - this.tokenBudget) / this.tokenRefillPerSecond) * 1000);

    return {
      ready: hasRequestPermit && hasTokenBudget,
      tokenHeadroom: this.tpm === null ? Number.POSITIVE_INFINITY : this.tokenBudget,
      requestHeadroom: this.requestPermits,
      msUntilReady: Math.max(requestWaitMs, tokenWaitMs, 0),
    };
  }

  // Blocks until both a request permit and `estimatedTokens` of budget are
  // available, then consumes both atomically. Bounded by `hardWaitTimeoutMs`.
  // `signal` (optional) lets an outer, caller-specific deadline cut this wait
  // short immediately instead of only ever bounding it via the fixed constant.
  async waitForBudget(estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    const oversized = this.isOversized(estimatedTokens);
    const waitStartedAt = Date.now();

    for (;;) {
      if (signal?.aborted === true) {
        throw new Error(`Rate limiter "${this.accountId}" wait aborted (caller deadline exceeded)`);
      }

      const snapshot = this.snapshotHeadroom(estimatedTokens);

      heartbeatBus.pulse('rate-limiter', `${this.accountId}: waiting for ~${estimatedTokens} tokens`);

      if (snapshot.ready) {
        this.requestPermits -= 1;

        if (this.tpm !== null) {
          if (oversized) {
            // Bucket just reached (or already was at) full capacity — track
            // the portion beyond capacity as debt (see `refillTokenBudget`)
            // rather than discarding it, so future refills pay it down first.
            this.debt += Math.max(0, estimatedTokens - this.tpm);
            this.tokenBudget = 0;
          } else {
            this.tokenBudget -= estimatedTokens;
          }
        }

        return;
      }

      const waitedMs = Date.now() - waitStartedAt;

      if (waitedMs >= this.hardWaitTimeoutMs) {
        throw new RateLimitEscalationError(
          `Rate limiter "${this.accountId}" did not secure budget for ~${estimatedTokens} tokens within ${this.hardWaitTimeoutMs}ms (waited ${waitedMs}ms)`,
          waitedMs,
          estimatedTokens,
          this.accountId,
        );
      }

      const jitterMs = Math.random() * RATE_LIMITER_POLL_JITTER_MS;
      const remainingMs = this.hardWaitTimeoutMs - waitedMs;
      const sleepMs = Math.min(Math.max(snapshot.msUntilReady, 1) + jitterMs, remainingMs);

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, sleepMs);

        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}

// Every real caller builds one of these per provider chain, centralized so
// PROVIDER_RATE_LIMITS is the only place a ceiling is ever defined. A
// provider with no known `rpm` yet gets no limiter at all (matching
// callWithFallback's "no map entry = unthrottled" behavior).
//
// `hardWaitTimeoutMs` is an optional passthrough to each limiter's own
// constructor — different callers need different values here since each
// wraps calls in its own governing timeout; every caller of this function
// must consciously choose a value that fits that timeout, not just accept a
// default meant for a different context.
export function buildRateLimitersForProviders(
  providers: LLMProvider[],
  hardWaitTimeoutMs?: number,
): Map<string, TokenBucketRateLimiter> {
  const rateLimiters = new Map<string, TokenBucketRateLimiter>();

  for (const provider of providers) {
    if (rateLimiters.has(provider.name)) {
      continue;
    }

    const limits: ProviderRateLimits | undefined = PROVIDER_RATE_LIMITS[provider.name];

    if (limits === undefined || limits.rpm === null) {
      continue;
    }

    rateLimiters.set(
      provider.name,
      new TokenBucketRateLimiter(limits.rpm, limits.tpm, hardWaitTimeoutMs, provider.name),
    );
  }

  return rateLimiters;
}
