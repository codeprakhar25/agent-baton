import fs from 'fs';
import path from 'path';
import type { AgentName, BatonConfig, NormalizedUsageStatus } from '../types.js';
import { getBatonDir, getThresholdNotifiedPath, loadConfig } from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { findActiveClaudeTranscript } from '../extractors/transcript/claude.js';
import { findActiveCodexTranscript } from '../extractors/transcript/codex.js';
import { formatNormalizedUsage, getCodexUsageTrigger, lookupClaudeUsage, readLatestCodexUsage } from '../extractors/usage.js';
import { buildHandoffDoc, writeHandoff } from '../writers/handoff.js';

interface HookInput {
  hook_event_name?: string;
  hookEventName?: string;
  event_name?: string;
  event?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
}

export async function runGuard(
  agent: AgentName,
  cwd: string,
  opts: { hook?: boolean; phase?: string; refresh?: boolean } = {},
): Promise<void> {
  if (agent !== 'claude' && agent !== 'codex') {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const hookInput = opts.hook ? readHookInput() : {};
  const resolvedCwd = hookInput.cwd ?? cwd;
  const cfg = loadConfig(resolvedCwd);
  const phase = hookInput.hook_event_name ?? hookInput.hookEventName ?? hookInput.event_name ?? hookInput.event ?? opts.phase;

  if (agent === 'codex') {
    await runCodexGuard(resolvedCwd, cfg, phase);
    return;
  }

  // Claude guard
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
      systemMessage: `Baton could not read Claude usage: ${initial.error ?? 'unknown error'}`,
    });
    return;
  }

  // SessionStart: refresh usage cache, clear prior notification.
  if (isSessionStart(phase)) {
    clearThresholdNotified(resolvedCwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  // Usage dropped below threshold — clear any stale notification.
  if (!initial.status.triggered) {
    clearThresholdNotified(resolvedCwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  // Triggered — do a confirmatory fresh fetch unless we already fetched.
  const confirmed = shouldFetch
    ? initial
    : await lookupClaudeUsage({ cwd: resolvedCwd, config: cfg, refresh: true });
  const usage = confirmed.status ?? initial.status;

  if (!usage.triggered) {
    clearThresholdNotified(resolvedCwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  // auto_handoff: always write handoff and block.
  if (cfg.limits.mode === 'auto_handoff') {
    const transcriptPath = (hookInput as { transcript_path?: string }).transcript_path ?? findActiveClaudeTranscript(resolvedCwd);
    const handoffPath = writeUsageLimitHandoff('claude', resolvedCwd, transcriptPath, usage, cfg);
    const message = [
      `${usage.triggerReason ?? 'Claude usage limit threshold crossed'}.`,
      confirmed.error ? `Fresh usage check failed, using cached usage: ${confirmed.error}.` : '',
      `Baton wrote a handoff: ${handoffPath}.`,
      'Run `baton pickup` to continue in another agent, or disable/remove the Baton hook if you intentionally want to keep using Claude.',
    ].filter(Boolean).join(' ');
    emitBlockForHook(phase, message);
    return;
  }

  // ask / warn_only: notify once per session.
  if (isThresholdNotified(resolvedCwd)) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  markThresholdNotified(resolvedCwd, usage);

  const warning = buildClaudeChoiceMessage(usage, confirmed.error);

  // Only inject on UserPromptSubmit — PreToolUse passes through.
  if (isUserPromptSubmit(phase)) {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Baton usage warning: ${warning}`,
      },
    });
  } else {
    emitHookJson({ suppressOutput: true });
  }
}

async function runCodexGuard(cwd: string, cfg: BatonConfig, phase: string | undefined): Promise<void> {
  // SessionStart: clear prior notification.
  if (isSessionStart(phase)) {
    clearThresholdNotified(cwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  const status = readLatestCodexUsage();
  const trigger = getCodexUsageTrigger(status, cfg);

  if (!trigger) {
    clearThresholdNotified(cwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  // auto_handoff: write handoff and block.
  if (cfg.limits.mode === 'auto_handoff' || (trigger.status.rateLimitReachedType && cfg.limits.auto_handoff_on_hard_limit)) {
    const transcriptPath = findActiveCodexTranscript();
    const handoffPath = writeUsageLimitHandoff('codex', cwd, transcriptPath, null, cfg, trigger.reason);
    const message = `${trigger.reason}. Baton wrote a handoff: ${handoffPath}. Run \`baton pickup\` to continue in another agent.`;
    emitBlockForHook(phase, message);
    return;
  }

  // ask / warn_only: notify once per session.
  if (isThresholdNotified(cwd)) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  markThresholdNotifiedRaw(cwd, trigger.reason);

  const warning = buildCodexChoiceMessage(trigger.reason);

  if (isUserPromptSubmit(phase)) {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Baton usage warning: ${warning}`,
      },
    });
  } else {
    emitHookJson({ suppressOutput: true });
  }
}

function buildClaudeChoiceMessage(usage: NormalizedUsageStatus, refreshError?: string): string {
  return [
    `${usage.triggerReason ?? 'Claude usage limit threshold crossed'}.`,
    refreshError ? `Fresh usage check failed, using cached usage: ${refreshError}.` : '',
    'Before doing more work, you MUST call the AskUserQuestion tool with exactly one question:',
    `question="Claude usage is at limit. How would you like to proceed?", header="Quota check", multiSelect=false,`,
    `options=[{label:"Continue in Claude", description:"Keep working with the remaining quota in this session"},`,
    `{label:"Write handoff & stop", description:"I will write a Baton handoff doc so you can pick up in another agent"}].`,
    'If the user chooses "Write handoff & stop": write the complete Markdown handoff file yourself, then run `baton handoff --from claude --reason rate-limit --file <path>`, and tell the user to run `baton pickup`.',
    'Do not write `pending-transfer.json` unless a handoff is requested or created.',
    'If a Baton permission prompt appears, proceed only when the user confirms that choice.',
  ].filter(Boolean).join(' ');
}

function buildCodexChoiceMessage(reason: string): string {
  return [
    `${reason}.`,
    'Before doing more work, ask the user to choose: continue in Codex with the remaining quota, or write a handoff and stop.',
    'If the user chooses handoff, write the complete Markdown handoff file yourself, then run `baton handoff --from codex --reason rate-limit --file <path>`, and tell the user to run `baton pickup`.',
    'Do not write `pending-transfer.json` unless a handoff is requested or created.',
  ].join(' ');
}

function writeUsageLimitHandoff(
  agent: AgentName,
  cwd: string,
  transcriptPath: string | null,
  usage: NormalizedUsageStatus | null,
  cfg: BatonConfig,
  summary?: string,
): string {
  const git = captureGitState(cwd, cfg.handoff_extraction.max_diff_chars);
  const session = extractSession(agent, transcriptPath, cwd, cfg.handoff_extraction.max_transcript_lines);
  const usageSummary = summary ?? (usage ? formatNormalizedUsage(usage) : 'usage limit reached');

  const doc = buildHandoffDoc({
    fromAgent: agent,
    reason: 'rate_limit',
    git,
    session,
    taskDescription: session.lastUserMessage ?? 'Unknown - see transcript tail',
    currentState: [
      `Usage-limit guard stopped ${agent}: ${usageSummary}.`,
      `Last assistant message: ${session.lastAssistantSummary ?? '(none)'}`,
    ].join(' '),
    errors: session.errors,
  });

  const handoffPath = writeHandoff(doc, cwd);

  fs.writeFileSync(path.join(getBatonDir(cwd), 'pending-transfer.json'), JSON.stringify({
    agent,
    reason: 'rate_limit',
    handoffPath,
    triggeredAt: new Date().toISOString(),
    ...(usage ? { usage } : {}),
  }, null, 2), 'utf8');

  return handoffPath;
}

function isThresholdNotified(cwd: string): boolean {
  return fs.existsSync(getThresholdNotifiedPath(cwd));
}

function markThresholdNotified(cwd: string, usage: NormalizedUsageStatus): void {
  markThresholdNotifiedRaw(cwd, usage.triggerReason ?? 'threshold crossed');
}

function markThresholdNotifiedRaw(cwd: string, reason: string): void {
  try {
    fs.mkdirSync(path.dirname(getThresholdNotifiedPath(cwd)), { recursive: true });
    fs.writeFileSync(getThresholdNotifiedPath(cwd), JSON.stringify({
      notifiedAt: new Date().toISOString(),
      triggerReason: reason,
    }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function clearThresholdNotified(cwd: string): void {
  try {
    fs.unlinkSync(getThresholdNotifiedPath(cwd));
  } catch { /* already absent */ }
}

// Codex v0.118+ passes the hook payload as a positional argv JSON string.
// Older versions and Claude Code use stdin.
function readHookInput(): HookInput {
  // Try last argv first (Codex v0.118+ style).
  const lastArg = process.argv[process.argv.length - 1];
  if (lastArg && lastArg.startsWith('{')) {
    try {
      return JSON.parse(lastArg) as HookInput;
    } catch { /* fall through to stdin */ }
  }

  // Fall back to stdin (Claude Code and older Codex).
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    // Codex may send multiple JSONL lines — use the last valid one.
    const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]) as HookInput; } catch { /* try next */ }
    }
    return {};
  } catch {
    return {};
  }
}

function emitBlockForHook(eventName: string | undefined, reason: string): void {
  if (isPreToolUse(eventName)) {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
    return;
  }

  if (isSessionStart(eventName)) {
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

function isSessionStart(eventName: string | undefined): boolean {
  return eventName === 'SessionStart' || eventName === 'session-start';
}

function isUserPromptSubmit(eventName: string | undefined): boolean {
  return eventName === 'UserPromptSubmit' || eventName === 'prompt-submit';
}

function isPreToolUse(eventName: string | undefined): boolean {
  return eventName === 'PreToolUse' || eventName === 'pre-tool';
}

function emitHookJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
