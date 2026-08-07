#!/usr/bin/env node
import { Command } from 'commander';

import { runAnalyzeCommand } from './analyze';
import { runAskCommand } from './ask';

const program = new Command();

program.name('sleuth').description('Sleuth — The Autonomous Codebase Detective');

program
  .command('analyze <target>')
  .description('Analyze a GitHub repository or local path and generate documentation')
  .option('--token <pat>', 'GitHub Personal Access Token for private repositories')
  .option('--max-files <n>', 'Maximum number of files to analyze')
  .option('--output <dir>', 'Output directory for generated Markdown (defaults to cwd)')
  .action(runAnalyzeCommand);

program
  .command('ask [question]')
  .description('Ask a question about the last-analyzed repository (resumes without re-cloning)')
  .action(runAskCommand);

program.parseAsync(process.argv);
