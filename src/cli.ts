/**
 * relay — cross-agent limit-aware handoff tool
 *
 * Commands:
 *   relay init                    — set up relay in current project
 *   relay usage --from <agent>    — print current usage-limit status
 *   relay guard --from <agent>    — hook command for usage-limit blocking
 *   relay watch --from <agent>    — monitor usage limits and write handoffs
 *   relay handoff --from <agent>  — manually capture task state + handoff file
 *   relay pickup [--to <agent>]   — choose next agent and launch it with handoff
 */

import { Command } from 'commander';
import type { AgentName } from './types.js';

const VALID_AGENTS: AgentName[] = ['cursor', 'claude', 'codex', 'gemini'];

function assertAgent(value: string): AgentName {
  if (!VALID_AGENTS.includes(value as AgentName)) {
    console.error(`Invalid agent: "${value}". Must be one of: ${VALID_AGENTS.join(', ')}`);
    process.exit(1);
  }
  return value as AgentName;
}

const program = new Command();

program
  .name('relay')
  .description('Cross-agent handoff tool for Cursor, Claude Code, and Codex')
  .version('0.1.0');

program
  .command('init')
  .description('Set up relay in the current project for usage-limit handoffs')
  .action(async () => {
    const { runInit } = await import('./commands/init.js');
    await runInit(process.cwd());
  });

program
  .command('watch')
  .description('Background daemon: monitor usage limits and trigger handoffs')
  .requiredOption('--from <agent>', 'Which agent to watch')
  .option('--cwd <path>', 'Working directory to monitor', process.cwd())
  .action(async (opts: { from: string; cwd: string }) => {
    const agent = assertAgent(opts.from);
    const { runWatch } = await import('./commands/watch.js');
    await runWatch(agent, opts.cwd);
  });

program
  .command('usage')
  .description('Print current usage-limit status')
  .requiredOption('--from <agent>', 'Which agent usage source to read')
  .option('--cwd <path>', 'Working directory to use for relay cache', process.cwd())
  .option('--json', 'Print machine-readable JSON', false)
  .option('--refresh', 'Bypass cache and fetch fresh usage if possible', false)
  .action(async (opts: { from: string; cwd: string; json: boolean; refresh: boolean }) => {
    const agent = assertAgent(opts.from);
    const { runUsage } = await import('./commands/usage.js');
    await runUsage(agent, opts.cwd, { json: opts.json, refresh: opts.refresh });
  });

program
  .command('guard')
  .description('Claude hook guard: block when usage limit threshold is crossed')
  .requiredOption('--from <agent>', 'Which agent usage source to guard')
  .option('--cwd <path>', 'Working directory to use for relay cache', process.cwd())
  .option('--hook', 'Read Claude hook JSON from stdin and emit hook JSON', false)
  .option('--phase <phase>', 'Hook phase label for non-JSON invocations')
  .option('--refresh', 'Bypass cache and fetch fresh usage if possible', false)
  .action(async (opts: { from: string; cwd: string; hook: boolean; phase?: string; refresh: boolean }) => {
    const agent = assertAgent(opts.from);
    const { runGuard } = await import('./commands/guard.js');
    await runGuard(agent, opts.cwd, { hook: opts.hook, phase: opts.phase, refresh: opts.refresh });
  });

program
  .command('handoff')
  .description('Manually capture task state and write a handoff file')
  .requiredOption('--from <agent>', 'Which agent you are handing off from')
  .option('--launch', 'Immediately prompt to launch the next agent', false)
  .action(async (opts: { from: string; launch: boolean }) => {
    const agent = assertAgent(opts.from);
    const { runHandoff } = await import('./commands/handoff.js');
    await runHandoff(agent, process.cwd(), opts.launch);
  });

program
  .command('pickup')
  .description('Pick up a pending task: choose next agent and launch it with the handoff')
  .option('--to <agent>', 'Skip the picker and launch a specific agent')
  .action(async (opts: { to: string }) => {
    const toAgent = opts.to ? assertAgent(opts.to) : undefined;
    const { runPickup } = await import('./commands/handoff.js');
    await runPickup(process.cwd(), toAgent);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
