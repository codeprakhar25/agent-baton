import fs from 'fs';
import path from 'path';
import type { AgentName, BatonConfig, NotificationState, NormalizedUsageStatus } from '../types.js';
import {
  clearNotificationState,
  computeTtl,
  getBatonDir,
  loadConfig,
  readNotificationState,
  writeNotificationState,
} from '../config.js';
import { captureGitState } from '../extractors/git.js';
import { extractSession } from '../extractors/transcript/index.js';
import { findActiveClaudeTranscript } from '../extractors/transcript/claude.js';
import { findActiveCodexTranscript } from '../extractors/transcript/codex.js';
import {
  formatNormalizedUsage,
  getCodexUsageTrigger,
  lookupClaudeUsage,
  readLatestCodexUsage,
} from '../extractors/usage.js';
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

  if (isSessionStart(phase)) {
    await handleClaudeSessionStart(resolvedCwd, cfg);
    return;
  }

  if (isUserPromptSubmit(phase)) {
    await handleClaudeUserPromptSubmit(resolvedCwd, cfg, hookInput, phase);
    return;
  }

  if (isPreToolUse(phase)) {
    await handleClaudePreToolUse(resolvedCwd, cfg, phase);
    return;
  }

  emitHookJson({ suppressOutput: true });
}

// ─── Claude: SessionStart ────────────────────────────────────────────────────

async function handleClaudeSessionStart(cwd: string, cfg: BatonConfig): Promise<void> {
  const result = await lookupClaudeUsage({ cwd, config: cfg, refresh: true });
  clearNotificationState(cwd);

  if (!result.status) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const usage = result.status;
  const maxPercent = getMaxPercent(usage);
  const warnAt = getWarnAt(cfg);

  if (maxPercent >= cfg.limits.handoff_percent || usage.triggered) {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildStartupMessage(usage, cfg, 'hard'),
      },
    });
  } else if (maxPercent >= warnAt) {
    emitHookJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildStartupMessage(usage, cfg, 'soft'),
      },
    });
  } else {
    emitHookJson({ suppressOutput: true });
  }
}

// ─── Claude: UserPromptSubmit ────────────────────────────────────────────────

async function handleClaudeUserPromptSubmit(
  cwd: string,
  cfg: BatonConfig,
  hookInput: HookInput,
  phase: string | undefined,
): Promise<void> {
  const result = await lookupClaudeUsage({ cwd, config: cfg, refresh: true });
  if (!result.status) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const usage = result.status;

  if (cfg.limits.mode === 'auto_handoff' && usage.triggered) {
    const transcriptPath = hookInput.transcript_path ?? findActiveClaudeTranscript(cwd);
    const handoffPath = writeUsageLimitHandoff('claude', cwd, transcriptPath, usage, cfg);
    const message = [
      `${usage.triggerReason ?? 'Claude usage limit threshold crossed'}.`,
      `Baton wrote a handoff: ${handoffPath}.`,
      'Run `baton pickup` to continue in another agent.',
    ].join(' ');
    emitBlockForHook(phase, message);
    return;
  }

  const maxPercent = getMaxPercent(usage);
  const warnAt = getWarnAt(cfg);
  const state = readNotificationState(cwd);
  const severity = resolveNotifySeverity(maxPercent, warnAt, cfg.limits.handoff_percent, state, cfg);

  if (!severity) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const now = new Date().toISOString();
  const patch: Partial<NotificationState> = { lastNotifiedAt: now, lastNotifiedPercent: maxPercent };
  if (!state.warningBandNotifiedAt && maxPercent >= warnAt) {
    patch.warningBandNotifiedAt = now;
    patch.warningBandPercent = maxPercent;
  }
  if (!state.thresholdNotifiedAt && maxPercent >= cfg.limits.handoff_percent) {
    patch.thresholdNotifiedAt = now;
    patch.thresholdPercent = maxPercent;
  }
  writeNotificationState(cwd, patch);

  emitHookJson({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Baton usage warning: ${buildClaudeChoiceMessage(usage, severity, result.error)}`,
    },
  });
}

// ─── Claude: PreToolUse ──────────────────────────────────────────────────────

async function handleClaudePreToolUse(cwd: string, cfg: BatonConfig, phase: string | undefined): Promise<void> {
  const cached = await lookupClaudeUsage({ cwd, config: cfg, cacheOnly: true });
  const state = readNotificationState(cwd);
  const needsFetch = !cached.status || !isDynamicCacheFresh(cached.status, cfg);
  const canFetch = canFetchFromPreTool(state, cfg);

  let usage = cached.status;
  if (needsFetch && canFetch) {
    writeNotificationState(cwd, { preToolLastFetchAt: new Date().toISOString() });
    const fresh = await lookupClaudeUsage({ cwd, config: cfg, refresh: true });
    if (fresh.status) {
      usage = fresh.status;
    }
  }

  if (!usage) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const maxPercent = getMaxPercent(usage);

  // PreToolUse only notifies at the hard threshold — softer band warnings come via UserPromptSubmit.
  if (maxPercent < cfg.limits.handoff_percent && !usage.triggered) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  // A recent soft warning must not suppress a newly hard threshold.
  if (isRecentHardNotification(state, cfg.limits.handoff_percent, cfg.usage_cache.pretool_ttl_ms)) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const now = new Date().toISOString();
  writeNotificationState(cwd, {
    lastNotifiedAt: now,
    lastNotifiedPercent: maxPercent,
    thresholdNotifiedAt: state.thresholdNotifiedAt ?? now,
    thresholdPercent: state.thresholdPercent ?? maxPercent,
  });

  emitHookJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: buildClaudePreToolMessage(usage),
    },
  });
}

function isDynamicCacheFresh(status: NormalizedUsageStatus, cfg: BatonConfig): boolean {
  const fetched = Date.parse(status.fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  return Date.now() - fetched < computeTtl(getMaxPercent(status), cfg);
}

function canFetchFromPreTool(state: NotificationState, cfg: BatonConfig): boolean {
  const lastFetch = state.preToolLastFetchAt ? Date.parse(state.preToolLastFetchAt) : 0;
  return !Number.isFinite(lastFetch) || Date.now() - lastFetch > cfg.usage_cache.pretool_ttl_ms;
}

function isRecentHardNotification(state: NotificationState, handoffPercent: number, cooldownMs: number): boolean {
  return typeof state.lastNotifiedPercent === 'number'
    && state.lastNotifiedPercent >= handoffPercent
    && !isCooldownExpired(state, cooldownMs);
}

// ─── Codex guard ─────────────────────────────────────────────────────────────

async function runCodexGuard(cwd: string, cfg: BatonConfig, phase: string | undefined): Promise<void> {
  if (isSessionStart(phase)) {
    clearNotificationState(cwd);
    emitHookJson({ suppressOutput: true });
    return;
  }

  const status = readLatestCodexUsage();
  const trigger = getCodexUsageTrigger(status, cfg);

  if (!trigger) {
    if (!isUserPromptSubmit(phase)) {
      emitHookJson({ suppressOutput: true });
      return;
    }
    const state = readNotificationState(cwd);
    if (state.warningBandNotifiedAt || state.thresholdNotifiedAt) {
      clearNotificationState(cwd);
    }
    emitHookJson({ suppressOutput: true });
    return;
  }

  if (cfg.limits.mode === 'auto_handoff' || (trigger.status.rateLimitReachedType && cfg.limits.auto_handoff_on_hard_limit)) {
    const transcriptPath = findActiveCodexTranscript();
    const handoffPath = writeUsageLimitHandoff('codex', cwd, transcriptPath, null, cfg, trigger.reason);
    const message = `${trigger.reason}. Baton wrote a handoff: ${handoffPath}. Run \`baton pickup\` to continue in another agent.`;
    emitBlockForHook(phase, message);
    return;
  }

  if (!isUserPromptSubmit(phase)) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const state = readNotificationState(cwd);
  const maxPercent = status ? Math.max(...status.windows.map(w => w.usedPercent)) : 0;
  const warnAt = getWarnAt(cfg);
  const severity = resolveNotifySeverity(maxPercent, warnAt, cfg.limits.handoff_percent, state, cfg);

  if (!severity) {
    emitHookJson({ suppressOutput: true });
    return;
  }

  const now = new Date().toISOString();
  const patch: Partial<NotificationState> = { lastNotifiedAt: now, lastNotifiedPercent: maxPercent };
  if (!state.warningBandNotifiedAt && maxPercent >= warnAt) {
    patch.warningBandNotifiedAt = now;
    patch.warningBandPercent = maxPercent;
  }
  if (!state.thresholdNotifiedAt && maxPercent >= cfg.limits.handoff_percent) {
    patch.thresholdNotifiedAt = now;
    patch.thresholdPercent = maxPercent;
  }
  writeNotificationState(cwd, patch);

  emitHookJson({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Baton usage warning: ${buildCodexChoiceMessage(trigger.reason, severity)}`,
    },
  });
}

// ─── Notification logic ───────────────────────────────────────────────────────

function resolveNotifySeverity(
  maxPercent: number,
  warnAt: number,
  handoffPercent: number,
  state: NotificationState,
  cfg: BatonConfig,
): 'soft' | 'hard' | null {
  if (maxPercent >= handoffPercent) return 'hard';
  if (maxPercent < warnAt) return null;
  if (!state.warningBandNotifiedAt) return 'soft';
  if (isCooldownExpired(state, cfg.usage_cache.notify_cooldown_ms)) return 'soft';
  return null;
}

function isCooldownExpired(state: NotificationState, cooldownMs: number): boolean {
  if (!state.lastNotifiedAt) return true;
  const last = Date.parse(state.lastNotifiedAt);
  return !Number.isFinite(last) || Date.now() - last > cooldownMs;
}

function getMaxPercent(usage: NormalizedUsageStatus): number {
  return Math.max(usage.fiveHourPercent ?? 0, usage.weeklyPercent ?? 0, usage.extraUsagePercent ?? 0);
}

function getWarnAt(cfg: BatonConfig): number {
  return cfg.limits.handoff_percent - cfg.limits.warning_buffer_percent;
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildStartupMessage(usage: NormalizedUsageStatus, cfg: BatonConfig, severity: 'soft' | 'hard'): string {
  const maxPercent = getMaxPercent(usage);
  if (severity === 'hard') {
    return [
      `Claude usage is already at ${maxPercent.toFixed(0)}% — at or above your ${cfg.limits.handoff_percent}% handoff threshold.`,
      'Before responding to the user, you MUST call the AskUserQuestion tool:',
      `question="Claude is at ${maxPercent.toFixed(0)}% usage — at the handoff threshold. How would you like to proceed?", header="Quota check", multiSelect=false,`,
      `options=[{label:"Continue in Claude", description:"Keep working with remaining quota"},`,
      `{label:"Write handoff & stop", description:"Write a Baton handoff so you can pick up in another agent"}].`,
      'If the user chooses "Write handoff & stop": write the Markdown handoff, run `baton handoff --from claude --reason rate-limit --file <path>`, tell the user to run `baton pickup`.',
    ].join(' ');
  }
  return [
    `Claude usage is at ${maxPercent.toFixed(0)}% — ${cfg.limits.handoff_percent - maxPercent}% from your configured handoff threshold.`,
    'You may want to consider a handoff soon.',
  ].join(' ');
}

function buildClaudeChoiceMessage(usage: NormalizedUsageStatus, severity: 'soft' | 'hard', refreshError?: string): string {
  const maxPercent = getMaxPercent(usage);
  const label = severity === 'hard'
    ? `${usage.triggerReason ?? `Claude usage is at ${maxPercent.toFixed(0)}% — handoff threshold reached`}`
    : `Claude usage is at ${maxPercent.toFixed(0)}% — approaching handoff threshold`;
  return [
    `${label}.`,
    refreshError ? `Fresh usage check failed, using cached data: ${refreshError}.` : '',
    'Before doing more work, you MUST call the AskUserQuestion tool with exactly one question:',
    `question="Claude usage at ${maxPercent.toFixed(0)}%. How would you like to proceed?", header="Quota check", multiSelect=false,`,
    `options=[{label:"Continue in Claude", description:"Keep working with the remaining quota in this session"},`,
    `{label:"Write handoff & stop", description:"I will write a Baton handoff doc so you can pick up in another agent"}].`,
    'If the user chooses "Write handoff & stop": write the complete Markdown handoff file yourself, then run `baton handoff --from claude --reason rate-limit --file <path>`, and tell the user to run `baton pickup`.',
    'Do not write `pending-transfer.json` unless a handoff is requested.',
  ].filter(Boolean).join(' ');
}

function buildClaudePreToolMessage(usage: NormalizedUsageStatus): string {
  const maxPercent = getMaxPercent(usage);
  return [
    `Tool blocked: Claude usage is at ${maxPercent.toFixed(0)}% — at or above the handoff threshold.`,
    'Before retrying this tool, you MUST call the AskUserQuestion tool:',
    `question="Claude is at ${maxPercent.toFixed(0)}% — handoff threshold reached mid-task. Continue or write handoff?", header="Quota check", multiSelect=false,`,
    `options=[{label:"Continue in Claude", description:"Retry the tool and keep working with remaining quota"},`,
    `{label:"Write handoff & stop", description:"Write a Baton handoff doc so you can pick up in another agent"}].`,
    'If the user chooses "Write handoff & stop": write the complete Markdown handoff, run `baton handoff --from claude --reason rate-limit --file <path>`, tell the user to run `baton pickup`.',
  ].join(' ');
}

function buildCodexChoiceMessage(reason: string, severity: 'soft' | 'hard'): string {
  const tone = severity === 'hard'
    ? `${reason}. Before doing more work, ask the user to choose: continue in Codex with the remaining quota, or write a handoff and stop.`
    : `${reason} — approaching the handoff threshold. Consider whether to continue or write a handoff soon.`;
  return [
    tone,
    'If the user chooses handoff: write the complete Markdown handoff file yourself, then run `baton handoff --from codex --reason rate-limit --file <path>`, and tell the user to run `baton pickup`.',
  ].join(' ');
}

// ─── Handoff writer ───────────────────────────────────────────────────────────

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

// ─── Hook helpers ─────────────────────────────────────────────────────────────

function isSessionStart(eventName: string | undefined): boolean {
  return eventName === 'SessionStart' || eventName === 'session-start';
}

function isUserPromptSubmit(eventName: string | undefined): boolean {
  return eventName === 'UserPromptSubmit' || eventName === 'prompt-submit';
}

function isPreToolUse(eventName: string | undefined): boolean {
  return eventName === 'PreToolUse' || eventName === 'pre-tool';
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
    emitHookJson({ continue: false, stopReason: reason });
    return;
  }

  emitHookJson({ decision: 'block', reason });
}

function readHookInput(): HookInput {
  const lastArg = process.argv[process.argv.length - 1];
  if (lastArg && lastArg.startsWith('{')) {
    try { return JSON.parse(lastArg) as HookInput; } catch { /* fall through */ }
  }
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    const lines = raw.split('\n').filter(l => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]) as HookInput; } catch { /* try next */ }
    }
    return {};
  } catch {
    return {};
  }
}

function emitHookJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
