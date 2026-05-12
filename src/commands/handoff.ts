/**
 * relay handoff --from <agent>
 *
 * Manual handoff: extract context from the current agent session,
 * write the handoff document, then optionally launch the next agent.
 * Used when the user wants to transfer work deliberately (not limit-triggered).
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import type { AgentName } from '../types.js';
import { loadConfig, getLatestHandoffPath } from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { buildHandoffDoc, writeHandoff } from '../writers/handoff.js';
import { isAgentAvailable, launchAgent, relativeHandoffPath } from '../launchers/index.js';

export async function runHandoff(fromAgent: AgentName, cwd: string, autoLaunch = false): Promise<void> {
  const cfg = loadConfig(cwd);

  console.log(chalk.bold(`\nrelay handoff — from: ${chalk.cyan(fromAgent)}\n`));
  console.log(chalk.gray('Capturing context...'));

  // 1. Git state
  const git = captureGitState(cwd, cfg.context_extraction.max_diff_chars);
  console.log(chalk.green('✓') + ` Git: branch=${git.branch}, ${git.modifiedFiles.length} modified file(s)`);

  // 2. Session transcript
  const session = extractSession(fromAgent, null, cwd, cfg.context_extraction.max_transcript_lines);
  console.log(chalk.green('✓') + ` Session: ${session.recentToolCalls.length} recent tool calls extracted`);

  // 3. Build and write handoff
  const doc = buildHandoffDoc({
    fromAgent,
    reason: 'manual',
    git,
    session,
  });

  const handoffPath = writeHandoff(doc, cwd);
  console.log(chalk.green('✓') + ` Handoff written: ${chalk.bold(handoffPath)}\n`);

  if (autoLaunch) {
    await selectAndLaunch(cwd, handoffPath, fromAgent, cfg);
    return;
  }

  console.log(`Handoff file: ${chalk.cyan(handoffPath)}`);
  console.log(`\nRun ${chalk.cyan('relay pickup')} to transfer to the next agent.`);
  console.log(`Or open the handoff file to review it before transferring.\n`);
}

export async function runPickup(cwd: string, toAgent?: AgentName): Promise<void> {
  const cfg = loadConfig(cwd);

  const handoffPath = getLatestHandoffPath(cwd);
  if (!handoffPath) {
    console.log(chalk.yellow('No handoff file found in .relay/handoffs/'));
    console.log(chalk.gray(`Run \`relay handoff --from <agent>\` first to create one.\n`));
    process.exit(1);
  }

  console.log(chalk.bold('\nrelay pickup\n'));
  console.log(chalk.gray(`Handoff: ${handoffPath}\n`));

  if (toAgent) {
    await launchWithAgent(toAgent, cwd, handoffPath);
    return;
  }

  await selectAndLaunch(cwd, handoffPath, undefined, cfg);
}

async function selectAndLaunch(
  cwd: string,
  handoffPath: string,
  fromAgent: AgentName | undefined,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  // Build available agent options sorted by priority
  const agents: AgentName[] = ['cursor', 'claude', 'codex'];
  const sortedAgents = agents
    .filter(a => a !== fromAgent) // can't transfer to self
    .filter(a => cfg.agents[a].enabled)
    .sort((a, b) => cfg.agents[a].priority - cfg.agents[b].priority);

  const choices = [
    ...sortedAgents.map(agent => {
      const available = isAgentAvailable(agent);
      return {
        name: available
          ? `${agent}  ${chalk.gray(`(priority ${cfg.agents[agent].priority})`)}`
          : `${agent}  ${chalk.red('(not installed)')}`,
        value: agent as string,
      };
    }),
    { name: chalk.gray("Skip — just write the handoff, don't launch"), value: 'skip' },
  ];

  const chosen = await select({
    message: 'Transfer to which agent?',
    choices,
  });

  if (chosen === 'skip') {
    console.log(chalk.gray('\nHandoff written. Launch the next agent manually.\n'));
    return;
  }

  await launchWithAgent(chosen as AgentName, cwd, handoffPath);
}

async function launchWithAgent(agent: AgentName, cwd: string, handoffPath: string): Promise<void> {
  if (!isAgentAvailable(agent)) {
    console.log(chalk.red(`\n${agent} is not installed or not on PATH.`));
    console.log(chalk.gray(`Install it and try: relay pickup --to ${agent}\n`));
    process.exit(1);
  }

  const relPath = relativeHandoffPath(handoffPath, cwd);

  console.log(chalk.bold(`\nLaunching ${chalk.cyan(agent)}...\n`));
  console.log(chalk.gray(`Handoff: ${relPath}\n`));

  launchAgent(agent, { cwd, handoffPath, relativeHandoffPath: relPath });

  // Clear the pending transfer flag after successful launch
  const flagPath = path.join(cwd, '.relay', 'pending-transfer.json');
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

