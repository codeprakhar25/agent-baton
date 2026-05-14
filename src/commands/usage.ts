import chalk from 'chalk';
import type { AgentName } from '../types.js';
import { loadConfig } from '../config.js';
import {
  formatCodexUsageTrigger,
  formatNormalizedUsage,
  getCodexUsageTrigger,
  lookupClaudeUsage,
  readLatestCodexUsage,
} from '../extractors/usage.js';

export async function runUsage(
  agent: AgentName,
  cwd: string,
  opts: { json?: boolean; refresh?: boolean } = {},
): Promise<void> {
  const cfg = loadConfig(cwd);

  if (agent === 'claude') {
    const result = await lookupClaudeUsage({ cwd, config: cfg, refresh: opts.refresh });
    if (!result.status) {
      if (opts.json) {
        console.log(JSON.stringify({ agent, available: false, error: result.error ?? 'usage unavailable' }, null, 2));
      } else {
        console.error(chalk.red(`Claude usage unavailable: ${result.error ?? 'unknown error'}`));
      }
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result.status, null, 2));
      return;
    }

    console.log(formatNormalizedUsage(result.status));
    if (result.status.triggered) {
      console.log(chalk.red(`threshold crossed: ${result.status.triggerReason}`));
    }
    if (result.error) {
      console.log(chalk.yellow(`using stale cache: ${result.error}`));
    }
    return;
  }

  if (agent === 'codex') {
    const status = readLatestCodexUsage();
    const trigger = getCodexUsageTrigger(status, cfg);
    if (opts.json) {
      console.log(JSON.stringify({ status, trigger }, null, 2));
      return;
    }
    if (!status) {
      console.error(chalk.red('Codex usage unavailable: no rollout rate_limits event found'));
      process.exitCode = 1;
      return;
    }
    const windows = status.windows.map(w => `${w.kind}=${w.usedPercent.toFixed(0)}%`).join(' ');
    console.log(`codex usage ${windows}`);
    if (trigger) {
      console.log(chalk.red(`threshold crossed: ${formatCodexUsageTrigger(trigger)}`));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ agent, available: false, error: 'usage lookup not implemented' }, null, 2));
  } else {
    console.error(chalk.red(`${agent} usage lookup is not implemented yet`));
  }
  process.exitCode = 1;
}
