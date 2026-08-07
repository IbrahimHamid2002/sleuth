import {
  PROVIDER_CHARS_PER_TOKEN_ESTIMATE,
  PROVIDER_DEFAULT_RATE_LIMIT_WAIT_MS,
  PROVIDER_MAX_SINGLE_RATE_LIMIT_WAIT_MS,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_SERVER_ERROR_BACKOFFS_MS,
} from '../constants';
import type { LLMProvider, ProviderChainConfig } from '../types';

import { RateLimitEscalationError, type TokenBucketRateLimiter } from './rate-limiter';

export type { LLMProvider, ProviderChainConfig } from '../types';

// A provider occasionally returns a "successful" response whose completion
// text is empty/whitespace-only — a real, observed failure mode (root cause
// of a past Deep Dive empty-first-response bug). Every provider below treats
// that the same as a missing completion: a thrown error, not a silent
// "success" with nothing in it, so callWithFallback's retry/fallback catches it.
function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function throwIfAborted(signal: AbortSignal | undefined, providerName: string): void {
  if (signal?.aborted === true) {
    throw new Error(`${providerName} request aborted (caller deadline exceeded)`);
  }
}

// Abortable so a caller-side deadline can interrupt a retry-after wait
// instead of letting it run to completion in the background.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('Aborted (caller deadline exceeded)'));

      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(new Error('Aborted (caller deadline exceeded)'));
      },
      { once: true },
    );
  });
}

// Groq's `retry-after` header follows RFC 7231 (seconds); the ms default only
// applies when the header is absent/unparseable. 429 gets the same retry
// budget as 5xx — a single retry was too easy to exhaust on Groq's free tier.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  providerName: string,
  signal?: AbortSignal,
): Promise<Response> {
  let rateLimitRetries = 0;
  let serverErrorRetries = 0;

  for (;;) {
    throwIfAborted(signal, providerName);

    const response = await fetch(url, { ...init, signal });

    if (response.ok) {
      return response;
    }

    if (response.status === 429 && rateLimitRetries < PROVIDER_RATE_LIMIT_MAX_RETRIES) {
      rateLimitRetries += 1;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
      const requestedWaitMs =
        retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? retryAfterSeconds * 1000
          : PROVIDER_DEFAULT_RATE_LIMIT_WAIT_MS;
      const waitMs = Math.min(requestedWaitMs, PROVIDER_MAX_SINGLE_RATE_LIMIT_WAIT_MS);

      await sleep(waitMs, signal);

      continue;
    }

    if (response.status >= 500) {
      const waitMs = PROVIDER_SERVER_ERROR_BACKOFFS_MS[serverErrorRetries];

      if (waitMs !== undefined) {
        serverErrorRetries += 1;

        await sleep(waitMs, signal);

        continue;
      }
    }

    const bodyText = await response.text();

    throw new Error(`${providerName} request failed with HTTP ${response.status}: ${bodyText}`);
  }
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (apiKey.length === 0) {
      throw new Error(`GroqProvider requires a non-empty API key (model "${model}")`);
    }

    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
        }),
      },
      this.name,
      signal,
    );

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;

    if (content === undefined || isBlank(content)) {
      throw new Error('groq returned no completion content');
    }

    return content;
  }
}

// OpenRouter's API is OpenAI-compatible — same request/response shape as
// GroqProvider, different host. Replaces Cerebras as the free-tier fallback
// (that account was confirmed billing-blocked — HTTP 402 — regardless of
// rate limits). No default model: unlike Cerebras/Gemini, there's no single
// free model that's the obviously right choice across every role, so every
// caller must explicitly state which one it wants (see ProviderChainConfig's
// comment and each caller's own model constant for the reasoning).
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    if (apiKey.length === 0) {
      throw new Error(`OpenRouterProvider requires a non-empty API key (model "${model}")`);
    }

    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string> {
    const response = await fetchWithRetry(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
        }),
      },
      this.name,
      signal,
    );

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;

    if (content === undefined || isBlank(content)) {
      throw new Error('openrouter returned no completion content');
    }

    return content;
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;

  // Live-verified against a real key: `gemini-flash-latest` is the one
  // confirmed to actually respond with content (gemini-2.0-flash returns 429
  // with zero free-tier quota; 2.5/1.5-flash 404 for this API version).
  constructor(apiKey: string, model = 'gemini-flash-latest') {
    if (apiKey.length === 0) {
      throw new Error('GeminiProvider requires a non-empty API key');
    }

    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: opts.maxTokens, temperature: opts.temperature },
        }),
      },
      this.name,
      signal,
    );

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (text === undefined || isBlank(text)) {
      throw new Error('gemini returned no completion content');
    }

    return text;
  }
}

// Different call sites commonly share the same Gemini fallback env var while
// naming distinct Groq ones — warn only once per distinct missing var name.
const warnedMissingEnvVars = new Set<string>();

export function warnMissingEnvVarOnce(envVar: string, providerLabel: string): void {
  if (warnedMissingEnvVars.has(envVar)) {
    return;
  }

  warnedMissingEnvVars.add(envVar);
  console.warn(`${envVar} is not set — skipping ${providerLabel} provider`);
}

// Every caller explicitly names which env var/model it wants — no built-in
// notion of "roles," so different callers reading the same env var but
// different models never accidentally share a chain that should stay
// separate. Fallback order is Groq -> OpenRouter -> Gemini by push order.
export function createProviderChain(config: ProviderChainConfig): LLMProvider[] {
  const providers: LLMProvider[] = [];
  const groqApiKey = process.env[config.groqApiKeyEnvVar];

  if (groqApiKey !== undefined) {
    providers.push(new GroqProvider(groqApiKey, config.groqModel));
  } else {
    warnMissingEnvVarOnce(config.groqApiKeyEnvVar, 'Groq');
  }

  const openrouterApiKeyEnvVar = config.openrouterApiKeyEnvVar ?? 'OPENROUTER_API_KEY';
  const openrouterApiKey = process.env[openrouterApiKeyEnvVar];

  if (openrouterApiKey !== undefined) {
    providers.push(new OpenRouterProvider(openrouterApiKey, config.openrouterModel));
  } else {
    warnMissingEnvVarOnce(openrouterApiKeyEnvVar, 'OpenRouter');
  }

  const geminiApiKeyEnvVar = config.geminiApiKeyEnvVar ?? 'GEMINI_API_KEY';
  const geminiApiKey = process.env[geminiApiKeyEnvVar];

  if (geminiApiKey !== undefined) {
    providers.push(new GeminiProvider(geminiApiKey, config.geminiModel));
  } else {
    warnMissingEnvVarOnce(geminiApiKeyEnvVar, 'Gemini');
  }

  return providers;
}

export function estimateTokenCost(prompt: string, maxOutputTokens: number): number {
  return Math.ceil(prompt.length / PROVIDER_CHARS_PER_TOKEN_ESTIMATE) + maxOutputTokens;
}

export async function callWithFallback(
  providers: LLMProvider[],
  prompt: string,
  opts: { maxTokens: number; temperature: number },
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  signal?: AbortSignal,
): Promise<string> {
  const errors: string[] = [];
  const estimatedTokens = estimateTokenCost(prompt, opts.maxTokens);

  for (const provider of providers) {
    if (signal?.aborted === true) {
      errors.push(`${provider.name}: skipped — caller deadline already exceeded`);

      break;
    }

    try {
      const limiter = rateLimiters.get(provider.name);

      if (limiter !== undefined) {
        // Waits until BOTH the request-count and estimated-token budget allow
        // this call through; past `hardWaitTimeoutMs` it throws
        // RateLimitEscalationError (caught below like any provider failure),
        // so this provider is skipped and the next one is tried immediately.
        await limiter.waitForBudget(estimatedTokens, signal);
      }

      return await provider.complete(prompt, opts, signal);
    } catch (err) {
      const reason =
        err instanceof RateLimitEscalationError
          ? `rate-limit escalation — ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);

      errors.push(`${provider.name}: ${reason}`);
      // Logged immediately so the real reason is visible even when a later
      // provider succeeds, rather than only surfacing if every provider fails.
      console.warn(`[LLM Fallback] Provider "${provider.name}" failed (${reason}) — trying the next provider`);
    }
  }

  throw new Error(`All LLM providers failed: ${errors.join('; ')}`);
}
