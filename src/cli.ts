#!/usr/bin/env node
/**
 * relay — cross-agent limit-aware handoff tool
 *
 * Commands:
 *   relay init                    — set up relay in current project
 *   relay check --from <agent>    — called by agent hooks (check thresholds)
 *   relay watch --from <agent>    — background daemon (dirty-path recovery)
 *   relay handoff --from <agent>  — manual context capture + handoff file
 *   relay pickup [--to <agent>]   — choose next agent and launch it with handoff
 */

import { Command } from 'commander';
import type { AgentName } from './types.js';

const VALID_AGENTS: AgentName[] = ['cursor', 'claude', 'codex'];

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
  .description('Set up relay in the current project (creates .relay/, installs hooks)')
  .option('--force', 'Overwrite existing hooks', false)
  .action(async (opts) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(process.cwd(), opts.force);
  });

program
  .command('check')
  .description('Check if the current session is approaching limits (called by agent hooks)')
  .requiredOption('--from <agent>', 'Which agent is calling this hook')
  .option('--event <event>', 'Hook event name', 'stop')
  .action(async (opts) => {
    const agent = assertAgent(opts.from);
    const { runCheck } = await import('./commands/check.js');
    await runCheck(agent, opts.event, process.cwd());
  });

program
  .command('watch')
  .description('Background daemon: detect dead sessions and trigger emergency handoffs')
  .requiredOption('--from <agent>', 'Which agent to watch')
  .option('--cwd <path>', 'Working directory to monitor', process.cwd())
  .action(async (opts) => {
    const agent = assertAgent(opts.from);
    const { runWatch } = await import('./commands/watch.js');
    await runWatch(agent, opts.cwd);
  });

program
  .command('handoff')
  .description('Manually capture context and write a handoff file')
  .requiredOption('--from <agent>', 'Which agent you are handing off from')
  .option('--launch', 'Immediately prompt to launch the next agent', false)
  .action(async (opts) => {
    const agent = assertAgent(opts.from);
    const { runHandoff } = await import('./commands/handoff.js');
    await runHandoff(agent, process.cwd(), opts.launch);
  });

program
  .command('pickup')
  .description('Pick up a pending task: choose next agent and launch it with the handoff context')
  .option('--to <agent>', 'Skip the picker and launch a specific agent')
  .action(async (opts) => {
    const toAgent = opts.to ? assertAgent(opts.to) : undefined;
    const { runPickup } = await import('./commands/handoff.js');
    await runPickup(process.cwd(), toAgent);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
