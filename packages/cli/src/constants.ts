// From analyze.ts
export const ANALYZE_GITHUB_URL_PATTERN = /github\.com/i;
export const ANALYZE_CACHE_HIT_RATE_PATTERN = /Cache hit rate: ([\d.]+)%/;
export const ANALYZE_CACHE_HIT_COUNT_PATTERN = /\((\d+)\/(\d+) files served from cache\)/;

// From ask.ts
export const ASK_EXIT_WORDS = new Set(['exit', 'quit', 'bye', 'goodbye']);

// From config.ts
export const CONFIG_KEYS = [
  'GROQ_SUMMARIZER_API_KEY',
  'GROQ_SYNTHESIZER_API_KEY',
  'GROQ_DEEP_DIVE_AGENT_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
] as const;
export const CONFIG_GROQ_KEYS_URL = 'https://console.groq.com/keys';
export const CONFIG_OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';
export const CONFIG_GEMINI_KEYS_URL = 'https://aistudio.google.com/api-keys';
