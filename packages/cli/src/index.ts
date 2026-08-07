#!/usr/bin/env node
import { Command } from 'commander';

import { runAnalyzeCommand } from './analyze';
import { runAskCommand } from './ask';
import { hydrateEnvFromConfig, runConfigListCommand, runConfigSetCommand } from './config';

// Fills process.env from ~/.sleuth/config.json for any key nothing has
// exported — must run before any command action so analyze/ask see it.
hydrateEnvFromConfig();

const program = new Command();

program.name('sleuth').description('Sleuth — The Autonomous Codebase Detective');

program
  .command('analyze <target>')
  .description('Analyze a GitHub repository or local path and generate documentation')
  .option('--token <pat>', 'GitHub Personal Access Token for private repositories')
  .option('--max-files <n>', 'Maximum number of files to analyze')
  .option('--output <dir>', 'Output directory for generated Markdown (defaults to cwd)')
  .option('--resume', 'Confirm/report whether this run resumed from a previous interrupted run (caching is always on regardless)')
  .action(runAnalyzeCommand);

program
  .command('ask [question]')
  .description('Ask a question about the last-analyzed repository (resumes without re-cloning)')
  .action(runAskCommand);

const configCommand = program.command('config').description('Manage persisted API keys (~/.sleuth/config.json)');

configCommand
  .command('set <key> <value>')
  .description('Save an API key for future runs (keys: GROQ_SUMMARIZER_API_KEY, GROQ_SYNTHESIZER_API_KEY, GROQ_DEEP_DIVE_AGENT_API_KEY, GEMINI_API_KEY)')
  .action(runConfigSetCommand);

configCommand.command('list').description('List which keys are configured (values masked)').action(runConfigListCommand);

program.parseAsync(process.argv);
