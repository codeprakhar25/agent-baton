/**
 * relay threshold <percent>
 * relay threshold --reset
 *
 * Dev-only: override all context threshold checks to a single value.
 * Sets dev.force_threshold in .relay/config.json.
 * Use a low value (e.g. 10) to test handoff flow without filling a real context window.
 */

import chalk from 'chalk';
import { loadConfig, saveConfig } from '../config.js';

export function runThreshold(value: string | undefined, reset: boolean, cwd: string): void {
  const cfg = loadConfig(cwd);

  if (reset) {
    saveConfig({ dev: { force_threshold: undefined } }, cwd);
    console.log(chalk.green('✓ Threshold override cleared — using real thresholds:'));
    console.log(chalk.gray(`  warn:    ${cfg.thresholds.warn_percent}%`));
    console.log(chalk.gray(`  prepare: ${cfg.thresholds.prepare_percent}%`));
    console.log(chalk.gray(`  handoff: ${cfg.thresholds.handoff_percent}%`));
    return;
  }

  if (value === undefined) {
    const current = cfg.dev?.force_threshold;
    if (current !== undefined) {
      console.log(chalk.yellow(`⚡ DEV MODE active: force_threshold = ${current}%`));
    } else {
      console.log(chalk.gray('No threshold override active. Real thresholds:'));
      console.log(chalk.gray(`  warn:    ${cfg.thresholds.warn_percent}%`));
      console.log(chalk.gray(`  prepare: ${cfg.thresholds.prepare_percent}%`));
      console.log(chalk.gray(`  handoff: ${cfg.thresholds.handoff_percent}%`));
    }
    return;
  }

  const pct = Number(value);
  if (isNaN(pct) || pct < 1 || pct > 99) {
    console.error(chalk.red('Error: threshold must be a number between 1 and 99'));
    process.exit(1);
  }

  saveConfig({ dev: { force_threshold: pct } }, cwd);

  console.log(chalk.yellow(`⚡ DEV MODE: force_threshold set to ${pct}%`));
  console.log(chalk.gray(`  All three stages (warn/prepare/handoff) will fire at ${pct}%.`));
  console.log(chalk.gray(`  Run: relay threshold --reset  to restore real thresholds.`));
  console.log(chalk.gray(`  Real thresholds: warn=${cfg.thresholds.warn_percent}%  prepare=${cfg.thresholds.prepare_percent}%  handoff=${cfg.thresholds.handoff_percent}%`));
}
