/**
 * baton — cross-agent limit-aware handoff tool
 *
 * Commands:
 *   baton init                    — set up baton in current project
 *   baton usage --from <agent>    — print current usage-limit status
 *   baton guard --from <agent>    — hook command for usage-limit blocking
 *   baton watch --from <agent>    — monitor usage limits and warn or hand off
 *   baton handoff --from <agent>  — manually capture task state + handoff file
 *   baton pickup [--to <agent>]   — choose next agent and launch it with handoff
 *   baton codex [-- <args>]       — preflight usage and launch Codex
 */

import { Command } from 'commander';
import type { AgentName, HandoffDocument } from './types.js';

const VALID_AGENTS: AgentName[] = ['cursor', 'claude', 'codex', 'gemini'];

function assertAgent(value: string): AgentName {
  if (!VALID_AGENTS.includes(value as AgentName)) {
    console.error(`Invalid agent: "${value}". Must be one of: ${VALID_AGENTS.join(', ')}`);
    process.exit(1);
  }
  return value as AgentName;
}

function assertHandoffReason(value: string): HandoffDocument['reason'] {
  if (value === 'manual') return 'manual';
  if (value === 'rate-limit' || value === 'rate_limit') return 'rate_limit';
  console.error(`Invalid handoff reason: "${value}". Must be one of: manual, rate-limit`);
  process.exit(1);
}

const program = new Command();

program
  .name('baton')
  .description('Cross-agent work baton for Cursor, Claude Code, Codex, and Gemini')
  .version('0.1.0');

program
  .command('init')
  .description('Set up baton in the current project for usage-limit handoffs')
  .action(async () => {
    const { runInit } = await import('./commands/init.js');
    await runInit(process.cwd());
  });

program
  .command('watch')
  .description('Background daemon: monitor usage limits and warn or hand off')
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
  .option('--cwd <path>', 'Working directory to use for baton cache', process.cwd())
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
  .option('--cwd <path>', 'Working directory to use for baton cache', process.cwd())
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
  .option('--reason <reason>', 'Why the handoff is being created: manual or rate-limit', 'manual')
  .option('--launch', 'Immediately prompt to launch the next agent', false)
  .action(async (opts: { from: string; reason: string; launch: boolean }) => {
    const agent = assertAgent(opts.from);
    const reason = assertHandoffReason(opts.reason);
    const { runHandoff } = await import('./commands/handoff.js');
    await runHandoff(agent, process.cwd(), opts.launch, reason);
  });

program
  .command('codex')
  .description('Preflight Codex usage, then launch Codex or create/pick up a handoff')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument('[args...]', 'Arguments or prompt to pass to Codex')
  .action(async (args: string[] = []) => {
    const { runCodex } = await import('./commands/codex.js');
    await runCodex(process.cwd(), args);
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
