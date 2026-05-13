/**
 * relay check --from <agent> --event <event>
 *
 * Called by the Stop hook in all three agents after every turn.
 *
 * IMPORTANT: Stop hook payloads never include context_window data.
 * Context % is read from .relay/context-state.json written by `relay statusline`.
 * If that file doesn't exist yet (statusline not configured), this is a no-op.
 *
 * Graduated stages based on context %:
 * - warn (85-89%):    soft followup — keep working, stay on current subtask
 * - prepare (90-94%): wrap-up followup — finish current step, stop
 * - handoff (≥95%):   no fresh handoff → ask agent to write one
 *                     fresh handoff exists → append git context, block
 */

import fs from 'fs';
import path from 'path';
import type { HookResponse, AgentName, RelayConfig, ThresholdStage } from '../types.js';
import { loadConfig, getHandoffDir, getLatestHandoffPath, readContextState } from '../config.js';
import { captureGitState } from '../extractors/git.js';

/** Maximum age of an existing handoff to consider it "fresh" (3 minutes) */
const HANDOFF_FRESH_MS = 3 * 60 * 1000;

export async function runCheck(agent: AgentName, event: string, cwd: string): Promise<void> {
  // Drain stdin — Stop hook sends data but context_window is never in it.
  // Context % comes from context-state.json written by `relay statusline`.
  readStdin().catch(() => {});

  const cfg = loadConfig(cwd);
  const state = readContextState(cwd);
  const usedPct = state?.pct ?? null;

  if (usedPct === null) {
    // Statusline not configured or hasn't fired yet — no-op
    respond({});
    return;
  }

  const stage = resolveStage(usedPct, cfg);

  if (stage === 'none') {
    respond({});
    return;
  }

  if (stage === 'warn') {
    respond({
      followup_message: `⚡ RELAY: Context at ${usedPct.toFixed(0)}%. Keep working — but stay on your current subtask only. Do not start anything new.`,
    });
    return;
  }

  if (stage === 'prepare') {
    respond({
      followup_message: `⚠️  RELAY: Context at ${usedPct.toFixed(0)}%. Finish the step you are currently on and stop. Do NOT start new subtasks. A handoff will be requested soon.`,
    });
    return;
  }

  // stage === 'handoff'
  const existingHandoff = getLatestHandoffPath(cwd);
  if (existingHandoff) {
    const age = Date.now() - fs.statSync(existingHandoff).mtimeMs;
    if (age < HANDOFF_FRESH_MS) {
      appendGitContext(existingHandoff, cwd, cfg);
      writePendingFlag(cwd, agent, usedPct, existingHandoff);
      respond({
        decision: 'block',
        reason: buildTransferPrompt(agent, usedPct, existingHandoff),
      });
      return;
    }
  }

  respond({ followup_message: buildHandoffRequestMessage(agent, usedPct, cwd) });
}

function resolveStage(usedPct: number, cfg: RelayConfig): ThresholdStage {
  const f = cfg.dev?.force_threshold ?? null;
  const warn    = f ?? cfg.thresholds.warn_percent;
  const prepare = f ?? cfg.thresholds.prepare_percent;
  const handoff = f ?? cfg.thresholds.handoff_percent;
  if (usedPct >= handoff) return 'handoff';
  if (usedPct >= prepare) return 'prepare';
  if (usedPct >= warn)    return 'warn';
  return 'none';
}

function appendGitContext(handoffPath: string, cwd: string, cfg: RelayConfig): void {
  try {
    const existing = fs.readFileSync(handoffPath, 'utf8');
    if (existing.includes('<!-- relay:git-appended -->')) return;

    const git = captureGitState(cwd, cfg.context_extraction.max_diff_chars);

    const appended = [
      ``,
      `<!-- relay:git-appended -->`,
      `---`,
      `## Git State (appended by relay)`,
      ``,
      `**Branch:** \`${git.branch}\`  |  **Uncommitted changes:** ${git.hasUncommittedChanges ? 'Yes' : 'No'}`,
      ``,
      `### Modified Files`,
      `\`\`\``,
      git.status || '(clean)',
      `\`\`\``,
      ``,
      `### Diff Stat`,
      `\`\`\``,
      git.diffStat || '(none)',
      `\`\`\``,
      ``,
      `### Recent Commits`,
      `\`\`\``,
      git.recentCommits || '(none)',
      `\`\`\``,
      ``,
      `### Uncommitted Diff`,
      git.diff ? `\`\`\`diff\n${git.diff}\n\`\`\`` : '(no uncommitted diff)',
    ].join('\n');

    const updated = existing + appended;
    fs.writeFileSync(handoffPath, updated, 'utf8');

    const latestPath = path.join(path.dirname(handoffPath), 'HANDOFF-latest.md');
    if (handoffPath !== latestPath) {
      fs.writeFileSync(latestPath, updated, 'utf8');
    }
  } catch { /* best effort */ }
}

function buildHandoffRequestMessage(agent: AgentName, usedPct: number, cwd: string): string {
  const handoffDir = getHandoffDir(cwd);
  const handoffPath = path.join(handoffDir, 'HANDOFF-latest.md');

  return [
    `🚨 RELAY — CRITICAL: Context is at ${usedPct.toFixed(0)}%. You have ONE response left.`,
    ``,
    `Write a handoff document to \`${handoffPath}\` RIGHT NOW using exactly this format:`,
    ``,
    `# Relay Handoff: <one-line task summary>`,
    ``,
    `## Task Description`,
    `<what is the overall goal — be specific>`,
    ``,
    `## Progress`,
    `- [x] <completed item 1>`,
    `- [x] <completed item 2>`,
    `- [ ] <remaining item — what is still left>`,
    ``,
    `## Key Decisions Made`,
    `- <decision and WHY you made it>`,
    ``,
    `## Current State`,
    `<exactly what you were doing when you stopped. Which file. Which function. What the next step is.>`,
    ``,
    `## Errors / Blockers`,
    `- <any errors or things that blocked you>`,
    ``,
    `IMPORTANT: Write ONLY this file. Do not run any tools after writing it. Do not summarize. Just write the file and stop.`,
    `The relay will automatically capture git state and offer the next agent to continue.`,
  ].join('\n');
}

function buildTransferPrompt(agent: AgentName, usedPct: number, handoffPath: string): string {
  return [
    ``,
    `╔══════════════════════════════════════════════════════╗`,
    `║              RELAY: LIMIT REACHED                   ║`,
    `╚══════════════════════════════════════════════════════╝`,
    ``,
    `Agent: ${agent}   Context: ${usedPct.toFixed(0)}%`,
    `Handoff written to: ${handoffPath}`,
    ``,
    `Run: relay pickup`,
    `  to select the next agent and continue your work.`,
    ``,
  ].join('\n');
}

function writePendingFlag(cwd: string, agent: AgentName, usedPct: number, handoffPath: string): void {
  const flagPath = path.join(cwd, '.relay', 'pending-transfer.json');
  try {
    fs.writeFileSync(flagPath, JSON.stringify({
      agent,
      usedPct,
      handoffPath,
      triggeredAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function respond(response: HookResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || !process.stdin.readable) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000);
  });
}
