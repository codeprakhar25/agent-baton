import fs from 'fs';
import path from 'path';
import type { AgentName, NormalizedUsageStatus } from '../types.js';
import { getRelayDir, loadConfig } from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { findActiveClaudeTranscript } from '../extractors/transcript/claude.js';
import { formatNormalizedUsage, lookupClaudeUsage } from '../extractors/usage.js';
import { buildHandoffDoc, writeHandoff } from '../writers/handoff.js';

interface ClaudeHookInput {
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
}

export async function runGuard(
  agent: AgentName,
  cwd: string,
  opts: { hook?: boolean; phase?: string; refresh?: boolean } = {},
): Promise<void> {
  if (agent !== 'claude') {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const hookInput = opts.hook ? readHookInput() : {};
  const resolvedCwd = hookInput.cwd ?? cwd;
  const cfg = loadConfig(resolvedCwd);
  const phase = hookInput.hook_event_name ?? opts.phase;
  const shouldFetch = opts.refresh || phase === 'SessionStart' || opts.phase === 'session-start';
  const initial = await lookupClaudeUsage({
    cwd: resolvedCwd,
    config: cfg,
    refresh: shouldFetch,
    cacheOnly: !shouldFetch,
  });

  if (!initial.status) {
    emitHookJson({
      suppressOutput: true,
      systemMessage: `Relay could not read Claude usage: ${initial.error ?? 'unknown error'}`,
    });
    return;
  }

  if (!initial.status.triggered) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const confirmed = shouldFetch
    ? initial
    : await lookupClaudeUsage({ cwd: resolvedCwd, config: cfg, refresh: true });
  const usage = confirmed.status ?? initial.status;

  if (!usage.triggered) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const transcriptPath = hookInput.transcript_path ?? findActiveClaudeTranscript(resolvedCwd);
  const handoffPath = writeUsageLimitHandoff('claude', resolvedCwd, transcriptPath, usage);
  const message = [
    `${usage.triggerReason ?? 'Claude usage limit threshold crossed'}.`,
    confirmed.error ? `Fresh usage check failed, using cached usage: ${confirmed.error}.` : '',
    `Relay wrote a handoff: ${handoffPath}.`,
    'Run `relay pickup` to continue in another agent, or disable/remove the Relay hook if you intentionally want to keep using Claude.',
  ].filter(Boolean).join(' ');

  emitBlockForHook(phase, message);
}

function writeUsageLimitHandoff(
  agent: AgentName,
  cwd: string,
  transcriptPath: string | null,
  usage: NormalizedUsageStatus,
): string {
  const cfg = loadConfig(cwd);
  const git = captureGitState(cwd, cfg.handoff_extraction.max_diff_chars);
  const session = extractSession(agent, transcriptPath, cwd, cfg.handoff_extraction.max_transcript_lines);
  const summary = formatNormalizedUsage(usage);

  const doc = buildHandoffDoc({
    fromAgent: agent,
    reason: 'rate_limit',
    git,
    session,
    taskDescription: session.lastUserMessage ?? 'Unknown - see transcript tail',
    currentState: [
      `Usage-limit guard stopped Claude: ${summary}.`,
      `Last assistant message: ${session.lastAssistantSummary ?? '(none)'}`,
    ].join(' '),
    errors: session.errors,
  });

  const handoffPath = writeHandoff(doc, cwd);

  fs.writeFileSync(path.join(getRelayDir(cwd), 'pending-transfer.json'), JSON.stringify({
    agent,
    reason: 'rate_limit',
    handoffPath,
    triggeredAt: new Date().toISOString(),
    usage,
  }, null, 2), 'utf8');

  return handoffPath;
}

function readHookInput(): ClaudeHookInput {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as ClaudeHookInput;
  } catch {
    return {};
  }
}

function emitBlockForHook(eventName: string | undefined, reason: string): void {
  if (eventName === 'PreToolUse') {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
    return;
  }

  if (eventName === 'SessionStart') {
    emitHookJson({
      continue: false,
      stopReason: reason,
    });
    return;
  }

  emitHookJson({
    decision: 'block',
    reason,
  });
}

function emitHookJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
