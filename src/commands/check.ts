/**
 * relay check --from <agent> --event <event>
 *
 * Called by hooks in all three agents on every stop/turn-end event.
 * Reads JSON from stdin (hook payload), checks thresholds, and:
 *
 * - Below threshold: outputs {} and exits (no-op)
 * - Above threshold, no handoff written yet: tells agent to write the handoff
 * - Handoff already written: outputs a block/stop signal so user can transfer
 *
 * This is the CLEAN PATH entry point.
 */

import fs from 'fs';
import path from 'path';
import type { HookPayload, HookResponse, AgentName } from '../types.js';
import { loadConfig, getHandoffDir, getLatestHandoffPath } from '../config.js';

/** Maximum age of an existing handoff to consider it "fresh" (3 minutes) */
const HANDOFF_FRESH_MS = 3 * 60 * 1000;

export async function runCheck(agent: AgentName, event: string, cwd: string): Promise<void> {
  const rawInput = await readStdin();
  let payload: HookPayload = {};

  try {
    payload = JSON.parse(rawInput);
  } catch {
    // Hooks may send empty or non-JSON in some edge cases — treat as no-op
    respond({});
    return;
  }

  const cfg = loadConfig(cwd);
  const threshold = cfg.thresholds.context_window_percent;
  const usedPct = payload.context_window?.used_percentage ?? null;

  // No context data in payload — can't make a decision, pass through
  if (usedPct === null) {
    respond({});
    return;
  }

  if (usedPct < threshold) {
    // Under threshold: no-op, let the agent keep going
    respond({});
    return;
  }

  // We are above threshold.
  // Check if a fresh handoff was already written (agent obeyed our earlier followup_message).
  const existingHandoff = getLatestHandoffPath(cwd);
  if (existingHandoff) {
    const age = Date.now() - fs.statSync(existingHandoff).mtimeMs;
    if (age < HANDOFF_FRESH_MS) {
      // Handoff was written — write the "pending transfer" flag and let the agent stop naturally.
      writePendingFlag(cwd, agent, usedPct, existingHandoff);
      // Return a block decision so the agent stops and the user sees the message in the terminal.
      const response: HookResponse = {
        decision: 'block',
        reason: buildTransferPrompt(agent, usedPct, existingHandoff),
      };
      respond(response);
      return;
    }
  }

  // No fresh handoff yet — ask the agent to write one as its next action.
  const followup = buildHandoffRequestMessage(agent, usedPct, cwd);
  const response: HookResponse = { followup_message: followup };
  respond(response);
}

function buildHandoffRequestMessage(agent: AgentName, usedPct: number, cwd: string): string {
  const handoffDir = getHandoffDir(cwd);
  const filename = `HANDOFF-latest.md`;
  const handoffPath = path.join(handoffDir, filename);

  return [
    `⚠️  RELAY NOTICE: Your context window is at ${usedPct.toFixed(0)}% — you are approaching your limit.`,
    ``,
    `Before your context fills completely, write a handoff document to \`${handoffPath}\` using this exact format:`,
    ``,
    `# Relay Handoff: <one-line task summary>`,
    ``,
    `## Task Description`,
    `<what is the overall goal>`,
    ``,
    `## Progress`,
    `- [x] <completed item>`,
    `- [ ] <remaining item>`,
    ``,
    `## Key Decisions Made`,
    `- <important architectural/design decision you made and why>`,
    ``,
    `## Current State`,
    `<exactly what you were doing when you stopped — be specific>`,
    ``,
    `## Errors / Blockers`,
    `- <any errors or blockers encountered>`,
    ``,
    `After writing this file, stop. Do not start new tasks. The relay will transfer your work to another agent.`,
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
    // Fallback timeout in case stdin never closes (non-piped invocation)
    setTimeout(done, 2000);
  });
}
