export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerSecond: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;

    if (elapsedSeconds <= 0) {
      return;
    }

    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSeconds * this.refillRatePerSecond);
    this.lastRefillAt = now;
  }

  async waitForToken(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;

      return;
    }

    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.ceil((tokensNeeded / this.refillRatePerSecond) * 1000);

    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

    return this.waitForToken();
  }
}
