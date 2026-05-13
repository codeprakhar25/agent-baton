/**
 * relay watch --from <agent>
 *
 * Runs as a background process alongside the active agent.
 *
 * What it does every poll cycle:
 * 1. Finds the agent's active transcript/usage source
 * 2. Checks usage-limit percentages when the agent exposes them
 * 3. Scans new transcript bytes for hard usage-limit errors
 * 4. Writes a rate-limit handoff and pending-transfer flag when needed
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
import { findActiveGeminiTranscript } from '../extractors/transcript/gemini.js';
import { detectRateLimitHit } from '../monitors/rate-limit.js';
import {
  formatCodexUsageTrigger,
  formatNormalizedUsage,
  getCodexUsageTrigger,
  lookupClaudeUsage,
  parseCodexUsageFromText,
  readLatestCodexUsage,
} from '../extractors/usage.js';

function findActiveTranscript(agent: AgentName, cwd: string): string | null {
  switch (agent) {
    case 'claude': return findActiveClaudeTranscript(cwd);
    case 'cursor': return findActiveCursorTranscript(cwd);
    case 'codex':  return findActiveCodexTranscript();
    case 'gemini': return findActiveGeminiTranscript();
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

async function writeRateLimitHandoff(
  agent: AgentName,
  transcriptPath: string | null,
  cwd: string,
  triggerSummary?: string,
): Promise<void> {
  const cfg = loadConfig(cwd);

  console.error(chalk.red.bold(`\n╔══════════════════════════════════════════════════════╗`));
  console.error(chalk.red.bold(`║  RELAY WATCH: USAGE LIMIT DETECTED                  ║`));
  console.error(chalk.red.bold(`╚══════════════════════════════════════════════════════╝`));
  console.error(chalk.yellow(`\nAgent: ${agent}`));
  if (transcriptPath) console.error(chalk.yellow(`Transcript: ${transcriptPath}`));
  console.error(chalk.yellow(`\nExtracting context from transcript tail + git state...\n`));

  const git = captureGitState(cwd, cfg.handoff_extraction.max_diff_chars);
  const session = extractSession(agent, transcriptPath, cwd, cfg.handoff_extraction.max_transcript_lines);

  const doc = buildHandoffDoc({
    fromAgent: agent,
    reason: 'rate_limit',
    git,
    session,
    taskDescription: session.lastUserMessage ?? 'Unknown — see transcript tail',
    currentState: [
      triggerSummary ? `⚠️ ${triggerSummary}.` : '⚠️ Agent stopped mid-task.',
      `Last assistant message: ${session.lastAssistantSummary ?? '(none)'}`,
    ].join(' '),
    errors: session.errors,
  });

  const handoffPath = writeHandoff(doc, cwd);

  // Write pending transfer flag
  fs.writeFileSync(path.join(getRelayDir(cwd), 'pending-transfer.json'), JSON.stringify({
    agent,
    reason: 'rate_limit',
    handoffPath,
    triggeredAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.error(chalk.green(`\n✓ Usage-limit handoff written to: ${handoffPath}`));
  console.error(chalk.cyan(`\nRun:  relay pickup`));
  console.error(chalk.cyan(`  to select the next agent and continue the task.\n`));
}

async function maybeTriggerCodexUsageHandoff(
  transcriptPath: string,
  cwd: string,
  thresholdPercent: number,
  text?: string,
): Promise<boolean> {
  const status = text
    ? parseCodexUsageFromText(text, transcriptPath)
    : readLatestCodexUsage(transcriptPath);
  const trigger = getCodexUsageTrigger(status, thresholdPercent);

  if (!trigger) return false;

  const summary = formatCodexUsageTrigger(trigger);
  console.error(chalk.red.bold(`[relay watch] ${summary}`));
  await writeRateLimitHandoff('codex', transcriptPath, cwd, summary);
  return true;
}

async function maybeTriggerClaudeUsageHandoff(
  cwd: string,
): Promise<boolean> {
  const cfg = loadConfig(cwd);
  const result = await lookupClaudeUsage({ cwd, config: cfg });
  const status = result.status;

  if (!status?.triggered) return false;

  const transcriptPath = findActiveClaudeTranscript(cwd);
  const summary = status.triggerReason ?? formatNormalizedUsage(status);
  console.error(chalk.red.bold(`[relay watch] ${summary}`));
  await writeRateLimitHandoff('claude', transcriptPath, cwd, summary);
  return true;
}

function readTailBytes(filePath: string, byteCount: number): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - byteCount);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

export async function runWatch(agent: AgentName, cwd: string): Promise<void> {
  const cfg = loadConfig(cwd);
  const { poll_interval_ms } = cfg.watch;

  console.log(chalk.cyan(`relay watch`) + ` — monitoring ${chalk.bold(agent)} session in ${cwd}`);
  console.log(chalk.gray(`  Usage threshold: ${cfg.thresholds.rate_limit_percent}%`));
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

    if (agent === 'claude') {
      const triggered = await maybeTriggerClaudeUsageHandoff(cwd);
      if (triggered) return;
    }

    const transcriptPath = findActiveTranscript(agent, cwd);
    if (!transcriptPath) {
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
      if (agent === 'codex') {
        await maybeTriggerCodexUsageHandoff(transcriptPath, cwd, cfg.thresholds.rate_limit_percent);
      }
      return;
    }

    if (currentSize > state.lastSeenBytes) {
      // Scan new bytes for rate limit error patterns before updating state
      const newContent = readTailBytes(transcriptPath, currentSize - state.lastSeenBytes);
      if (agent === 'codex') {
        const triggered = await maybeTriggerCodexUsageHandoff(
          transcriptPath,
          cwd,
          cfg.thresholds.rate_limit_percent,
          newContent,
        );
        if (triggered) {
          state.lastSeenBytes = currentSize;
          state.lastSeenAt = now;
          saveWatchState(state, cwd);
          return;
        }
      }

      const hit = detectRateLimitHit([newContent]);
      if (hit) {
        const summary = `Rate limit detected: ${hit.matchedText}`;
        console.error(chalk.red.bold(`[relay watch] ${summary}`));
        await writeRateLimitHandoff(agent, transcriptPath, cwd, summary);
        state.lastSeenBytes = currentSize;
        state.lastSeenAt = now;
        saveWatchState(state, cwd);
        return;
      }

      state.lastSeenBytes = currentSize;
      state.lastSeenAt = now;
      saveWatchState(state, cwd);
      return;
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
