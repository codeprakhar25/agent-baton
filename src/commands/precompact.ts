/**
 * relay precompact --from <agent>
 *
 * Registered as PreCompact hook — fires when the agent is about to auto-compact
 * the context window. This is the last-resort safety net: context is at/near
 * the hard limit, compaction is imminent.
 *
 * Strategy:
 * - Write a handoff immediately (transcript tail + git state)
 * - Return {} to ALLOW compaction to proceed (blocking would hang the session)
 * - Write pending-transfer.json so the user sees the "relay pickup" prompt
 *
 * This catches the case where context filled up faster than the statusline
 * could warn (e.g. a single huge response consumed 30% of remaining context).
 *
 * Note: Because we allow compaction, the session may continue after this fires.
 * The handoff captures state at the moment of compaction — the best snapshot
 * available. If the user wants to transfer, run: relay pickup
 */

import fs from 'fs';
import path from 'path';
import type { AgentName } from '../types.js';
import { loadConfig, getRelayDir, readContextState } from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { buildHandoffDoc, writeHandoff } from '../writers/handoff.js';
import { findActiveClaudeTranscript } from '../extractors/transcript/claude.js';
import { findActiveCursorTranscript } from '../extractors/transcript/cursor.js';
import { findActiveCodexTranscript } from '../extractors/transcript/codex.js';
import { findActiveGeminiTranscript } from '../extractors/transcript/gemini.js';

function findTranscript(agent: AgentName, cwd: string): string | null {
  switch (agent) {
    case 'claude': return findActiveClaudeTranscript(cwd);
    case 'cursor': return findActiveCursorTranscript(cwd);
    case 'codex':  return findActiveCodexTranscript();
    case 'gemini': return findActiveGeminiTranscript();
  }
}

export async function runPreCompact(agent: AgentName, cwd: string): Promise<void> {
  const cfg = loadConfig(cwd);
  const state = readContextState(cwd);
  const pct = state?.pct;

  // Build emergency handoff from transcript + git
  const transcriptPath = findTranscript(agent, cwd);
  const git = captureGitState(cwd, cfg.context_extraction.max_diff_chars);

  const session = transcriptPath
    ? extractSession(agent, transcriptPath, cwd, cfg.context_extraction.max_transcript_lines)
    : { agent, recentToolCalls: [], progressItems: [], errors: [], transcriptTail: '' } as any;

  const doc = buildHandoffDoc({
    fromAgent: agent,
    reason: 'context_window',
    contextPercent: pct,
    git,
    session,
    taskDescription: session.lastUserMessage ?? 'Unknown — captured at auto-compaction',
    currentState: [
      `⚡ Pre-compaction snapshot at ${pct != null ? pct.toFixed(0) + '%' : 'unknown'} context.`,
      `The session was auto-compacted — this handoff preserves state before compaction.`,
      `Last assistant action: ${session.lastAssistantSummary ?? '(none)'}`,
    ].join(' '),
    errors: session.errors,
  });

  const handoffPath = writeHandoff(doc, cwd);

  // Write pending transfer flag
  fs.writeFileSync(
    path.join(getRelayDir(cwd), 'pending-transfer.json'),
    JSON.stringify({ agent, reason: 'precompact', pct, handoffPath, triggeredAt: new Date().toISOString() }, null, 2),
    'utf8',
  );

  process.stderr.write(`\n[relay] ⚡ Pre-compaction handoff written: ${handoffPath}\n`);
  process.stderr.write(`[relay] Run: relay pickup — to continue in another agent\n\n`);

  // Return {} — allow compaction to proceed so session doesn't hang
  process.stdout.write(JSON.stringify({}) + '\n');
}
