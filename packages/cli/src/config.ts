import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const CONFIG_KEYS = [
  'GROQ_SUMMARIZER_API_KEY',
  'GROQ_SYNTHESIZER_API_KEY',
  'GROQ_DEEP_DIVE_AGENT_API_KEY',
  'GEMINI_API_KEY',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

const ConfigSchema = z.record(z.string());

const GROQ_KEYS_URL = 'https://console.groq.com/keys';
const GEMINI_KEYS_URL = 'https://aistudio.google.com/api-keys';

// Resolved lazily (not a module-level constant) — mirrors analyze.ts's
// getSessionDir/getSessionFile pattern so tests can point HOME/USERPROFILE
// at a sandbox directory before invoking a command.
export function getConfigDir(): string {
  return join(homedir(), '.sleuth');
}

export function getConfigFile(): string {
  return join(getConfigDir(), 'config.json');
}

export function readConfig(): Partial<Record<ConfigKey, string>> {
  const configFile = getConfigFile();

  if (!existsSync(configFile)) {
    return {};
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(configFile, 'utf-8')));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: Partial<Record<ConfigKey, string>>): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
}

export function setConfigValue(key: ConfigKey, value: string): void {
  const config = readConfig();

  config[key] = value;
  writeConfig(config);
}

function maskKey(value: string): string {
  return value.length <= 8 ? '*'.repeat(value.length) : `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

// Real environment variables always win — this only fills gaps for keys
// nothing has exported, so CI/power users who already `export` are unaffected.
export function hydrateEnvFromConfig(): void {
  const config = readConfig();

  for (const key of CONFIG_KEYS) {
    const configValue = config[key];

    if ((process.env[key] === undefined || process.env[key] === '') && configValue !== undefined) {
      process.env[key] = configValue;
    }
  }
}

function isKeyUsable(envVar: ConfigKey): boolean {
  return process.env[envVar] !== undefined && process.env[envVar] !== '';
}

// Prompts once, only when neither the requested Groq role key nor the Gemini
// fallback is available anywhere (env or persisted config) — never nags if
// the pipeline can already fall back to Gemini. Asks for each of the 4 known
// keys individually (skipping ones already configured) in one inquirer.prompt
// call — inquirer runs an array of questions sequentially in a single call.
export async function ensureGroqApiKey(requiredEnvVar: ConfigKey): Promise<void> {
  if (isKeyUsable(requiredEnvVar) || isKeyUsable('GEMINI_API_KEY')) {
    return;
  }

  const missingKeys = CONFIG_KEYS.filter((key) => !isKeyUsable(key));

  if (missingKeys.length === 0) {
    return;
  }

  console.log(chalk.yellow('🔑 No API Keys found! Please enter your Groq + Gemini API Keys'));
  console.log(chalk.dim(`   Groq (free):   ${GROQ_KEYS_URL}`));
  console.log(chalk.dim(`   Gemini (free): ${GEMINI_KEYS_URL}`));

  const answers = await inquirer.prompt<Partial<Record<ConfigKey, string>>>(
    missingKeys.map((key) => ({
      type: 'password',
      name: key,
      mask: '*',
      message: `Enter ${key}:`,
    })),
  );

  let savedAny = false;

  for (const key of missingKeys) {
    const trimmed = answers[key]?.trim();

    if (trimmed !== undefined && trimmed.length > 0) {
      process.env[key] = trimmed;
      setConfigValue(key, trimmed);
      savedAny = true;
    }
  }

  if (savedAny) {
    console.log(chalk.green(`✅ Saved to ${getConfigFile()} — future runs will use these automatically.`));
  }
}

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export function runConfigSetCommand(key: string, value: string): void {
  if (!isConfigKey(key)) {
    console.error(chalk.red(`Error: unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`));
    process.exit(1);

    return;
  }

  setConfigValue(key, value);
  console.log(chalk.green(`✅ Saved ${key} to ${getConfigFile()}`));
}

export function runConfigListCommand(): void {
  const config = readConfig();

  for (const key of CONFIG_KEYS) {
    const value = config[key];

    console.log(`${key}: ${value !== undefined ? maskKey(value) : chalk.dim('(not set)')}`);
  }
}
