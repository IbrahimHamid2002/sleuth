import { DEEP_DIVE_GROQ_MODEL, DEEP_DIVE_GROQ_TPM, DEEP_DIVE_OPENROUTER_MODEL, DEEP_DIVE_RATE_LIMIT_HARD_WAIT_TIMEOUT_MS } from '../constants';
import { GroqProvider, OpenRouterProvider, warnMissingEnvVarOnce } from '../llm/provider';
import { buildRateLimitersForProviders, TokenBucketRateLimiter } from '../llm/rate-limiter';
import type { AgentProviders, LLMProvider } from '../types';

// Deep Dive agent provider routing: Groq (single account) first, OpenRouter
// as the sole, FINAL fallback — no Gemini, unlike the doc-synthesis pipeline.
// Built directly here (not via createProviderChain) so no Gemini entry or
// missing-env warning is produced for a path that never wants Gemini.
// Reasoning and synthesis share the exact same provider list/instances.
export function buildDeepDiveAgentProviders(): AgentProviders {
  const providers: LLMProvider[] = [];
  const groqApiKey = process.env.GROQ_DEEP_DIVE_AGENT_API_KEY;

  if (groqApiKey !== undefined) {
    providers.push(new GroqProvider(groqApiKey, DEEP_DIVE_GROQ_MODEL));
  } else {
    warnMissingEnvVarOnce('GROQ_DEEP_DIVE_AGENT_API_KEY', 'Groq');
  }

  const openrouterApiKey = process.env.OPENROUTER_API_KEY;

  if (openrouterApiKey !== undefined) {
    providers.push(new OpenRouterProvider(openrouterApiKey, DEEP_DIVE_OPENROUTER_MODEL));
  } else {
    warnMissingEnvVarOnce('OPENROUTER_API_KEY', 'OpenRouter');
  }

  return { reasoningProviders: providers, synthesisProviders: providers };
}

export function buildDeepDiveAgentRateLimiters(providers: AgentProviders): Map<string, TokenBucketRateLimiter> {
  const rateLimiters = buildRateLimitersForProviders(providers.reasoningProviders, DEEP_DIVE_RATE_LIMIT_HARD_WAIT_TIMEOUT_MS);
  const groqLimiter = rateLimiters.get('groq');

  // Override just the tpm ceiling for Groq (see DEEP_DIVE_GROQ_TPM) — rpm
  // stays whatever PROVIDER_RATE_LIMITS.groq says, since it isn't model-specific.
  if (groqLimiter !== undefined) {
    rateLimiters.set(
      'groq',
      new TokenBucketRateLimiter(groqLimiter.rpm, DEEP_DIVE_GROQ_TPM, DEEP_DIVE_RATE_LIMIT_HARD_WAIT_TIMEOUT_MS, 'groq'),
    );
  }

  return rateLimiters;
}
