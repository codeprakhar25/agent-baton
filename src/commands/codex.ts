import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { getUsageLimitPercent, loadConfig } from '../config.js';
import { runHandoff, runPickup } from './handoff.js';
import {
  formatCodexUsageTrigger,
  getCodexUsageTrigger,
  readLatestCodexUsage,
} from '../extractors/usage.js';

const CODEX_OPTIONS_WITH_VALUE = new Set([
  '-m',
  '--model',
  '-c',
  '--config',
  '--profile',
  '--sandbox',
  '--ask-for-approval',
  '--cd',
  '--cwd',
  '--image',
  '--output-schema',
]);

export async function runCodex(cwd: string, rawArgs: string[] = []): Promise<void> {
  const cfg = loadConfig(cwd);
  const args = rawArgs.filter(arg => arg !== '--');
  const status = readLatestCodexUsage();
  const trigger = getCodexUsageTrigger(status, getUsageLimitPercent(cfg));

  if (!trigger) {
    if (status) {
      const windows = status.windows.map(w => `${w.kind}=${w.usedPercent.toFixed(0)}%`).join(' ');
      console.log(chalk.gray(`Codex usage preflight: ${windows}`));
    } else {
      console.log(chalk.gray('Codex usage preflight unavailable; launching Codex normally.'));
    }
    launchCodex(cwd, cfg.agents.codex.bin ?? 'codex', args);
    return;
  }

  console.log(chalk.yellow(`Codex usage preflight: ${formatCodexUsageTrigger(trigger)}`));
  const choice = await select({
    message: 'Relay detected high Codex usage. What should happen next?',
    choices: [
      { name: 'Continue in Codex', value: 'continue' },
      { name: 'Create handoff now', value: 'handoff' },
      { name: 'Run relay pickup', value: 'pickup' },
    ],
  });

  if (choice === 'handoff') {
    await runHandoff('codex', cwd, false, 'rate_limit');
    return;
  }

  if (choice === 'pickup') {
    await runPickup(cwd);
    return;
  }

  launchCodex(cwd, cfg.agents.codex.bin ?? 'codex', withUsageWarningPrompt(args, formatCodexUsageTrigger(trigger)));
}

function withUsageWarningPrompt(args: string[], summary: string): string[] {
  const warning = [
    `Relay usage warning: ${summary}.`,
    'Before doing more work, ask the user whether to continue in Codex with remaining quota or prepare a handoff.',
    'If the user chooses handoff, run `relay handoff --from codex --reason rate-limit`, then tell the user to run `relay pickup`.',
  ].join(' ');

  const promptIndex = findPromptIndex(args);
  if (promptIndex === -1) {
    return [...args, warning];
  }

  return [
    ...args.slice(0, promptIndex),
    `${warning}\n\nOriginal prompt:\n${args.slice(promptIndex).join(' ')}`,
  ];
}

function findPromptIndex(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') continue;
    if (CODEX_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}

function launchCodex(cwd: string, bin: string, args: string[]): void {
  console.log(`\n$ ${bin} ${args.map(quoteArg).join(' ')}\n`);

  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw new Error(`Failed to launch Codex: ${result.error.message}`);
  }

  if (typeof result.status === 'number') {
    process.exitCode = result.status;
  }
}

function quoteArg(arg: string): string {
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}
