import type { TokenBucketRateLimiter } from './rate-limiter';

export interface LLMProvider {
  name: string;
  complete(prompt: string, opts: { maxTokens: number; temperature: number }): Promise<string>;
}

const SERVER_ERROR_BACKOFFS_MS = [500, 1000, 2000];
const DEFAULT_RATE_LIMIT_WAIT_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq's `retry-after` header follows RFC 7231 (seconds); the ms default above
// only applies when the header is absent or unparseable.
async function fetchWithRetry(url: string, init: RequestInit, providerName: string): Promise<Response> {
  let retriedAfterRateLimit = false;
  let serverErrorRetries = 0;

  for (;;) {
    const response = await fetch(url, init);

    if (response.ok) {
      return response;
    }

    if (response.status === 429 && !retriedAfterRateLimit) {
      retriedAfterRateLimit = true;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : undefined;
      const waitMs =
        retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? retryAfterSeconds * 1000
          : DEFAULT_RATE_LIMIT_WAIT_MS;

      await sleep(waitMs);

      continue;
    }

    if (response.status >= 500) {
      const waitMs = SERVER_ERROR_BACKOFFS_MS[serverErrorRetries];

      if (waitMs !== undefined) {
        serverErrorRetries += 1;

        await sleep(waitMs);

        continue;
      }
    }

    const bodyText = await response.text();

    throw new Error(`${providerName} request failed with HTTP ${response.status}: ${bodyText}`);
  }
}

// The constructor's single `model` argument doubles as the role selector: each
// summarizer/synthesizer model is tied to its own Groq API key so the two
// pipeline stages don't share one free-tier rate-limit budget.
const GROQ_MODEL_TO_ENV_VAR: Record<string, string> = {
  'llama-3.1-8b-instant': 'GROQ_SUMMARIZER_API_KEY',
  'llama-3.3-70b-versatile': 'GROQ_SYNTHESIZER_API_KEY',
};

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(model: string) {
    const envVarName = GROQ_MODEL_TO_ENV_VAR[model] ?? 'GROQ_SUMMARIZER_API_KEY';
    const apiKey = process.env[envVarName];

    if (apiKey === undefined) {
      throw new Error(`${envVarName} is not set — required to construct GroqProvider for model "${model}"`);
    }

    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }): Promise<string> {
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

  constructor(model = 'gemini-2.0-flash') {
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey === undefined) {
      throw new Error('GEMINI_API_KEY is not set — required to construct GeminiProvider');
    }

    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string, opts: { maxTokens: number; temperature: number }): Promise<string> {
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

const GROQ_ROLE_MODELS: Record<'summarizer' | 'synthesizer', string> = {
  summarizer: 'llama-3.1-8b-instant',
  synthesizer: 'llama-3.3-70b-versatile',
};

// `role` picks which Groq model/key this chain is for — summarization and
// synthesis must NOT share one chain, or synthesis silently gets routed
// through the summarizer's 8B key instead of the synthesizer's 70B key.
export function createProviderChain(role: 'summarizer' | 'synthesizer' = 'summarizer'): LLMProvider[] {
  const providers: LLMProvider[] = [];
  const model = GROQ_ROLE_MODELS[role];
  const envVarName = GROQ_MODEL_TO_ENV_VAR[model] ?? 'GROQ_SUMMARIZER_API_KEY';

  if (process.env[envVarName] !== undefined) {
    providers.push(new GroqProvider(model));
  } else {
    console.warn(`${envVarName} is not set — skipping Groq provider`);
  }

  if (process.env.GEMINI_API_KEY !== undefined) {
    providers.push(new GeminiProvider());
  } else {
    console.warn('GEMINI_API_KEY is not set — skipping Gemini provider');
  }

  return providers;
}

export async function callWithFallback(
  providers: LLMProvider[],
  prompt: string,
  opts: { maxTokens: number; temperature: number },
  rateLimiters: Map<string, TokenBucketRateLimiter>,
): Promise<string> {
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const limiter = rateLimiters.get(provider.name);

      if (limiter !== undefined) {
        await limiter.waitForToken();
      }

      return await provider.complete(prompt, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      errors.push(`${provider.name}: ${message}`);
    }
  }

  throw new Error(`All LLM providers failed: ${errors.join('; ')}`);
}
