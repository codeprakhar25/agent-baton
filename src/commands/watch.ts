/**
 * relay watch --from <agent>
 *
 * Runs as a background process alongside the active agent.
 * Handles the DIRTY PATH: when the agent dies mid-task without a clean hook exit.
 *
 * What it does every poll cycle:
 * 1. Finds the agent's active transcript file
 * 2. Checks if the transcript is being written to (file growing)
 * 3. If the transcript goes stale (no writes for N ms) AND no pending-transfer flag exists:
 *    - Agent likely died or hit a hard limit mid-task
 *    - Reads transcript tail to reconstruct last known state
 *    - Captures current git state (ground truth of what changed)
 *    - Writes an emergency HANDOFF file
 *    - Writes pending-transfer.json flag
 *    - Prints an alert to stderr (visible in terminal even if agent is gone)
 *
 * Also polls subscription rate limits if codex-cli-usage is available.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import type { AgentName, WatchState } from '../types.js';
import { loadConfig, getWatchStatePath, getRelayDir, getLatestHandoffPath } from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { buildHandoffDoc, writeHandoff } from '../writers/handoff.js';
import { findActiveClaudeTranscript } from '../extractors/transcript/claude.js';
import { findActiveCursorTranscript } from '../extractors/transcript/cursor.js';
import { findActiveCodexTranscript } from '../extractors/transcript/codex.js';

function findActiveTranscript(agent: AgentName, cwd: string): string | null {
  switch (agent) {
    case 'claude': return findActiveClaudeTranscript(cwd);
    case 'cursor': return findActiveCursorTranscript(cwd);
    case 'codex':  return findActiveCodexTranscript();
  }
}

function getTranscriptSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function loadWatchState(cwd: string): WatchState | null {
  const p = getWatchStatePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveWatchState(state: WatchState, cwd: string): void {
  const p = getWatchStatePath(cwd);
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function hasPendingTransfer(cwd: string): boolean {
  return fs.existsSync(path.join(getRelayDir(cwd), 'pending-transfer.json'));
}

async function doEmergencyExtraction(agent: AgentName, transcriptPath: string, cwd: string): Promise<void> {
  const cfg = loadConfig(cwd);

  console.error(chalk.red.bold(`\n╔══════════════════════════════════════════════════════╗`));
  console.error(chalk.red.bold(`║  RELAY WATCH: AGENT SESSION APPEARS TO HAVE DIED    ║`));
  console.error(chalk.red.bold(`╚══════════════════════════════════════════════════════╝`));
  console.error(chalk.yellow(`\nAgent: ${agent}`));
  console.error(chalk.yellow(`Transcript: ${transcriptPath}`));
  console.error(chalk.yellow(`\nExtracting context from transcript tail + git state...\n`));

  const git = captureGitState(cwd, cfg.context_extraction.max_diff_chars);
  const session = extractSession(agent, transcriptPath, cwd, cfg.context_extraction.max_transcript_lines);

  const doc = buildHandoffDoc({
    fromAgent: agent,
    reason: 'emergency',
    git,
    session,
    taskDescription: session.lastUserMessage ?? 'Unknown — see transcript tail',
    currentState: `⚠️ Agent stopped mid-task. Last assistant message: ${session.lastAssistantSummary ?? '(none)'}`,
    errors: session.errors,
  });

  const handoffPath = writeHandoff(doc, cwd);

  // Write pending transfer flag
  fs.writeFileSync(path.join(getRelayDir(cwd), 'pending-transfer.json'), JSON.stringify({
    agent,
    reason: 'emergency',
    handoffPath,
    triggeredAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.error(chalk.green(`\n✓ Emergency handoff written to: ${handoffPath}`));
  console.error(chalk.cyan(`\nRun:  relay pickup`));
  console.error(chalk.cyan(`  to select the next agent and continue the task.\n`));
}

export async function runWatch(agent: AgentName, cwd: string): Promise<void> {
  const cfg = loadConfig(cwd);
  const { poll_interval_ms, stale_threshold_ms } = cfg.watch;

  console.log(chalk.cyan(`relay watch`) + ` — monitoring ${chalk.bold(agent)} session in ${cwd}`);
  console.log(chalk.gray(`  Context threshold: ${cfg.thresholds.context_window_percent}%`));
  console.log(chalk.gray(`  Stale detection: ${stale_threshold_ms / 1000}s`));
  console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

  let state = loadWatchState(cwd);

  const tick = async () => {
    // Skip if a transfer is already pending (don't keep overwriting the handoff)
    if (hasPendingTransfer(cwd)) {
      const latestHandoff = getLatestHandoffPath(cwd);
      console.log(chalk.yellow(`[relay watch] Transfer pending. Run relay pickup to continue.`));
      if (latestHandoff) console.log(chalk.gray(`  Handoff: ${latestHandoff}`));
      return;
    }

    const transcriptPath = findActiveTranscript(agent, cwd);

    if (!transcriptPath) {
      // No transcript found yet — agent may not have started a session
      console.log(chalk.gray(`[relay watch] No active ${agent} transcript found. Waiting...`));
      return;
    }

    const currentSize = getTranscriptSize(transcriptPath);
    const now = Date.now();

    if (!state || state.transcriptPath !== transcriptPath) {
      // New transcript detected — start tracking it
      state = {
        agent,
        transcriptPath,
        lastSeenBytes: currentSize,
        lastSeenAt: now,
        cwd,
      };
      saveWatchState(state, cwd);
      console.log(chalk.gray(`[relay watch] Tracking transcript: ${path.basename(transcriptPath)}`));
      return;
    }

    if (currentSize > state.lastSeenBytes) {
      // Transcript is growing — agent is alive and working
      state.lastSeenBytes = currentSize;
      state.lastSeenAt = now;
      saveWatchState(state, cwd);
      return;
    }

    // Transcript is not growing — check if it's been stale long enough
    const staleDuration = now - state.lastSeenAt;

    if (staleDuration >= stale_threshold_ms) {
      console.log(chalk.yellow(`[relay watch] Transcript stale for ${Math.round(staleDuration / 1000)}s. Triggering emergency extraction...`));
      await doEmergencyExtraction(agent, transcriptPath, cwd);
      // Reset state so we don't keep re-triggering
      state.lastSeenAt = now;
      saveWatchState(state, cwd);
    }
  };

  // Initial tick
  await tick();

  // Poll loop
  const interval = setInterval(async () => {
    try {
      await tick();
    } catch (err) {
      console.error(chalk.red(`[relay watch] Error during poll: ${err}`));
    }
  }, poll_interval_ms);

  // Clean shutdown on signals
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.gray('\n[relay watch] Stopped.'));
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => { /* runs until signal */ });
}
