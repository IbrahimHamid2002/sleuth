import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { CONFIG_GEMINI_KEYS_URL, CONFIG_GROQ_KEYS_URL, CONFIG_KEYS, CONFIG_OPENROUTER_KEYS_URL } from './constants';
import type { ConfigKey } from './types';

export { CONFIG_KEYS } from './constants';
export type { ConfigKey } from './types';

const ConfigSchema = z.record(z.string());

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

// Prompts once, only when neither the requested Groq role key nor any
// fallback (OpenRouter, then Gemini) is available anywhere — never nags if
// the pipeline can already fall back to one of them.
export async function ensureGroqApiKey(requiredEnvVar: ConfigKey): Promise<void> {
  if (isKeyUsable(requiredEnvVar) || isKeyUsable('OPENROUTER_API_KEY') || isKeyUsable('GEMINI_API_KEY')) {
    return;
  }

  const missingKeys = CONFIG_KEYS.filter((key) => !isKeyUsable(key));

  if (missingKeys.length === 0) {
    return;
  }

  console.log(chalk.yellow('🔑 No API Keys found! Please enter your Groq + OpenRouter + Gemini API Keys'));
  console.log(chalk.dim(`   Groq (free):       ${CONFIG_GROQ_KEYS_URL}`));
  console.log(chalk.dim(`   OpenRouter (free): ${CONFIG_OPENROUTER_KEYS_URL}`));
  console.log(chalk.dim(`   Gemini (free):     ${CONFIG_GEMINI_KEYS_URL}`));

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
