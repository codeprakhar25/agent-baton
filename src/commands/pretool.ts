/**
 * relay pretool --from <agent>
 *
 * Registered as PreToolUse hook — fires before every tool call mid-response.
 * This is the mid-response gate that catches context overflow before it happens.
 *
 * Two-phase check:
 *   FAST PATH  (~0.1ms): fs.existsSync('.relay/danger-zone') → absent = pass through
 *   SLOW PATH (only when flagged): read context-state.json → if >= handoff% → block
 *
 * The danger-zone flag is written by `relay statusline` when context crosses warn%.
 * This means pretool adds near-zero overhead for 95% of tool calls.
 *
 * When blocked, the agent receives the handoff template as tool feedback and
 * writes the handoff file itself — preserving full narrative context.
 */

import fs from 'fs';
import path from 'path';
import type { AgentName } from '../types.js';
import {
  loadConfig, getRelayDir, getDangerZonePath, readContextState,
  getHandoffDir, getLatestHandoffPath,
} from '../config.js';

const HANDOFF_FRESH_MS = 3 * 60 * 1000;

export async function runPreTool(agent: AgentName, cwd: string): Promise<void> {
  // Always drain stdin (hook sends tool_name/tool_input — small payload, won't block)
  drainStdin();

  // FAST PATH: no danger zone = safe, pass through immediately
  if (!fs.existsSync(getDangerZonePath(cwd))) {
    respond({});
    return;
  }

  // SLOW PATH: we're in the danger zone — check actual context %
  const cfg = loadConfig(cwd);
  const state = readContextState(cwd);

  if (!state) { respond({}); return; }

  const f = cfg.dev?.force_threshold ?? null;
  const handoffThreshold = f ?? cfg.thresholds.handoff_percent;

  if (state.pct < handoffThreshold) { respond({}); return; }

  // At/above handoff threshold mid-response — block this tool call
  // Check if a fresh handoff was already written (agent obeyed an earlier block)
  const existing = getLatestHandoffPath(cwd);
  if (existing) {
    const age = Date.now() - fs.statSync(existing).mtimeMs;
    if (age < HANDOFF_FRESH_MS) {
      respond({ decision: 'block', reason: 'RELAY: Handoff written. Stop all tools now. Run: relay pickup' });
      return;
    }
  }

  const handoffPath = path.join(getHandoffDir(cwd), 'HANDOFF-latest.md');
  respond({ decision: 'block', reason: buildHandoffRequest(agent, state.pct, handoffPath) });
}

function buildHandoffRequest(agent: AgentName, pct: number, handoffPath: string): string {
  return [
    `🚨 RELAY — MID-RESPONSE STOP: Context is at ${pct.toFixed(0)}%.`,
    ``,
    `Stop immediately. Do NOT execute the tool you were about to call.`,
    `Write a handoff document to: ${handoffPath}`,
    ``,
    `# Relay Handoff: <one-line task summary>`,
    ``,
    `## Task Description`,
    `<overall goal — be specific>`,
    ``,
    `## Progress`,
    `- [x] <completed>`,
    `- [ ] <remaining — what is still left>`,
    ``,
    `## Key Decisions Made`,
    `- <decision and WHY>`,
    ``,
    `## Current State`,
    `<which file, which function, what the VERY NEXT step is>`,
    ``,
    `## Errors / Blockers`,
    `- <any errors>`,
    ``,
    `Write ONLY this file. Do not call any other tools after writing it.`,
  ].join('\n');
}

function respond(out: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(out) + '\n');
}

function drainStdin(): void {
  if (process.stdin.readable && !process.stdin.readableEnded) {
    process.stdin.resume(); // drain without reading content
  }
}
