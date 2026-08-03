import type { TokenBucketRateLimiter } from './rate-limiter';

export interface LLMProvider {
  name: string;
  complete(prompt: string, opts: { maxTokens: number; temperature: number }, signal?: AbortSignal): Promise<string>;
}

const SERVER_ERROR_BACKOFFS_MS = [500, 1000, 2000];
const DEFAULT_RATE_LIMIT_WAIT_MS = 2000;
const RATE_LIMIT_MAX_RETRIES = 3;

function throwIfAborted(signal: AbortSignal | undefined, providerName: string): void {
  if (signal?.aborted === true) {
    throw new Error(`${providerName} request aborted (caller deadline exceeded)`);
  }
}

// Abortable so a caller-side deadline (e.g. investigator.ts's 60s budget) can
// interrupt a retry-after wait instead of it running to completion in the
// background — see the callWithFallback/fetchWithRetry signal threading below.
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

// Groq's `retry-after` header follows RFC 7231 (seconds); the ms default above
// only applies when the header is absent or unparseable. 429 gets the same
// retry budget as 5xx (3 attempts) — a single retry was too easy to exhaust
// on Groq's free tier and caused premature fallback to Gemini even when Groq
// would have succeeded on a second or third attempt.
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

    if (response.status === 429 && rateLimitRetries < RATE_LIMIT_MAX_RETRIES) {
      rateLimitRetries += 1;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
      const waitMs =
        retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_WAIT_MS;

      await sleep(waitMs, signal);

      continue;
    }

    if (response.status >= 500) {
      const waitMs = SERVER_ERROR_BACKOFFS_MS[serverErrorRetries];

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

    if (content === undefined) {
      throw new Error('groq returned no completion content');
    }

    return content;
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = 'gemini-2.0-flash') {
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

    if (text === undefined) {
      throw new Error('gemini returned no completion content');
    }

    return text;
  }
}

export interface ProviderChainConfig {
  groqApiKeyEnvVar: string;
  groqModel: string;
  geminiApiKeyEnvVar?: string;
  geminiModel?: string;
}

// Every caller (pipeline summarization, pipeline synthesis, and the Deep Dive
// agent's two internal chains) explicitly names which env var/model it wants —
// this function has no built-in notion of "roles" itself, so different callers
// reading the same env var but different models (or vice versa) never
// accidentally share a provider chain that should have stayed separate.
export function createProviderChain(config: ProviderChainConfig): LLMProvider[] {
  const providers: LLMProvider[] = [];
  const groqApiKey = process.env[config.groqApiKeyEnvVar];

  if (groqApiKey !== undefined) {
    providers.push(new GroqProvider(groqApiKey, config.groqModel));
  } else {
    console.warn(`${config.groqApiKeyEnvVar} is not set — skipping Groq provider`);
  }

  const geminiApiKeyEnvVar = config.geminiApiKeyEnvVar ?? 'GEMINI_API_KEY';
  const geminiApiKey = process.env[geminiApiKeyEnvVar];

  if (geminiApiKey !== undefined) {
    providers.push(new GeminiProvider(geminiApiKey, config.geminiModel));
  } else {
    console.warn(`${geminiApiKeyEnvVar} is not set — skipping Gemini provider`);
  }

  return providers;
}

export async function callWithFallback(
  providers: LLMProvider[],
  prompt: string,
  opts: { maxTokens: number; temperature: number },
  rateLimiters: Map<string, TokenBucketRateLimiter>,
  signal?: AbortSignal,
): Promise<string> {
  const errors: string[] = [];
  let previousProviderName: string | undefined;

  for (const provider of providers) {
    if (signal?.aborted === true) {
      errors.push(`${provider.name}: skipped — caller deadline already exceeded`);

      break;
    }

    if (previousProviderName !== undefined) {
      console.warn(`[LLM Fallback] Provider "${previousProviderName}" failed, attempting "${provider.name}"`);
    }

    try {
      const limiter = rateLimiters.get(provider.name);

      if (limiter !== undefined) {
        await limiter.waitForToken();
      }

      return await provider.complete(prompt, opts, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      errors.push(`${provider.name}: ${message}`);
      previousProviderName = provider.name;
    }
  }

  throw new Error(`All LLM providers failed: ${errors.join('; ')}`);
}
