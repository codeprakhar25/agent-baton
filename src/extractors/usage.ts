import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NormalizedUsageStatus, RelayConfig } from '../types.js';
import { getUsageCachePath } from '../config.js';
import { findActiveCodexTranscript } from './transcript/codex.js';
import { tailFile } from './transcript/common.js';

export type CodexUsageWindowKind = 'five_hour' | 'weekly' | 'unknown';

export interface CodexUsageWindow {
  kind: CodexUsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexUsageStatus {
  agent: 'codex';
  transcriptPath?: string;
  updatedAt: string;
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  windows: CodexUsageWindow[];
}

export interface CodexUsageTrigger {
  status: CodexUsageStatus;
  window?: CodexUsageWindow;
  reason: string;
}

export interface ClaudeUsageLookupOptions {
  cwd: string;
  config: RelayConfig;
  refresh?: boolean;
  cacheOnly?: boolean;
}

export interface ClaudeUsageLookupResult {
  status: NormalizedUsageStatus | null;
  error?: string;
}

export async function lookupClaudeUsage(
  options: ClaudeUsageLookupOptions,
): Promise<ClaudeUsageLookupResult> {
  const cached = readUsageCache(options.cwd, 'claude');
  const threshold = options.config.thresholds.rate_limit_percent;

  if (options.cacheOnly) {
    if (!cached) {
      return { status: null, error: 'Claude usage cache missing' };
    }
    return {
      status: evaluateUsageThreshold(markCacheAge(cached), threshold),
    };
  }

  if (!options.refresh && cached && isUsageCacheFresh(cached, options.config)) {
    return {
      status: evaluateUsageThreshold({ ...cached, cacheStatus: 'fresh' }, threshold),
    };
  }

  try {
    const status = await fetchClaudeOAuthUsage(options.config, threshold);
    writeUsageCache(options.cwd, status);
    return { status };
  } catch (err) {
    if (cached) {
      return {
        status: evaluateUsageThreshold({ ...cached, cacheStatus: 'stale', stale: true }, threshold),
        error: String(err instanceof Error ? err.message : err),
      };
    }

    return {
      status: null,
      error: String(err instanceof Error ? err.message : err),
    };
  }
}

export function formatNormalizedUsage(status: NormalizedUsageStatus): string {
  const parts = [`${status.agent} usage`];
  if (typeof status.fiveHourPercent === 'number') {
    parts.push(`5h=${status.fiveHourPercent.toFixed(0)}%`);
  }
  if (typeof status.weeklyPercent === 'number') {
    parts.push(`weekly=${status.weeklyPercent.toFixed(0)}%`);
  }
  if (typeof status.extraUsagePercent === 'number') {
    parts.push(`extra=${status.extraUsagePercent.toFixed(0)}%`);
  }
  if (status.cacheStatus !== 'fresh') {
    parts.push(`cache=${status.cacheStatus}`);
  }
  return parts.join(' ');
}

export function readLatestCodexUsage(
  transcriptPath: string | null = null,
  maxLines = 500,
): CodexUsageStatus | null {
  const resolved = transcriptPath ?? findActiveCodexTranscript();
  if (!resolved) return null;

  try {
    const text = tailFile(resolved, maxLines).join('\n');
    return parseCodexUsageFromText(text, resolved);
  } catch {
    return null;
  }
}

export function parseCodexUsageFromText(
  text: string,
  transcriptPath?: string,
): CodexUsageStatus | null {
  let latest: CodexUsageStatus | null = null;

  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;

    try {
      const entry = JSON.parse(line) as {
        timestamp?: string;
        payload?: {
          type?: string;
          rate_limits?: CodexRateLimitsPayload;
        };
      };
      if (entry.payload?.type !== 'token_count' || !entry.payload.rate_limits) continue;

      const status = normalizeCodexRateLimits(
        entry.payload.rate_limits,
        entry.timestamp ?? new Date().toISOString(),
        transcriptPath,
      );

      if (!latest || Date.parse(status.updatedAt) >= Date.parse(latest.updatedAt)) {
        latest = status;
      }
    } catch {
      // Skip malformed/incomplete JSONL lines. Active rollout files may be mid-write.
    }
  }

  return latest;
}

export function getCodexUsageTrigger(
  status: CodexUsageStatus | null,
  thresholdPercent: number,
): CodexUsageTrigger | null {
  if (!status) return null;

  if (status.rateLimitReachedType) {
    return {
      status,
      reason: `Codex rate limit reached: ${status.rateLimitReachedType}`,
    };
  }

  const window = status.windows
    .filter(w => w.usedPercent >= thresholdPercent)
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];

  if (!window) return null;

  return {
    status,
    window,
    reason: `Codex ${formatCodexWindowKind(window)} usage is ${window.usedPercent.toFixed(0)}%`,
  };
}

export function formatCodexUsageTrigger(trigger: CodexUsageTrigger): string {
  const { status, window } = trigger;
  const parts = [trigger.reason];

  if (window?.resetsAt) {
    parts.push(`resets ${new Date(window.resetsAt * 1000).toISOString()}`);
  }
  if (status.planType) {
    parts.push(`plan=${status.planType}`);
  }

  return parts.join('; ');
}

function normalizeCodexRateLimits(
  payload: CodexRateLimitsPayload,
  updatedAt: string,
  transcriptPath?: string,
): CodexUsageStatus {
  const windows = [
    normalizeCodexWindow(payload.primary),
    normalizeCodexWindow(payload.secondary),
  ].filter((w): w is CodexUsageWindow => w !== null);

  return {
    agent: 'codex',
    transcriptPath,
    updatedAt,
    limitId: payload.limit_id,
    limitName: payload.limit_name,
    planType: payload.plan_type,
    rateLimitReachedType: payload.rate_limit_reached_type,
    windows,
  };
}

function normalizeCodexWindow(raw: CodexRateLimitWindowPayload | null | undefined): CodexUsageWindow | null {
  if (!raw || typeof raw.used_percent !== 'number') return null;

  return {
    kind: codexWindowKind(raw.window_minutes),
    usedPercent: raw.used_percent,
    remainingPercent: Math.max(0, 100 - raw.used_percent),
    windowMinutes: raw.window_minutes,
    resetsAt: raw.resets_at,
  };
}

function codexWindowKind(windowMinutes: number | undefined): CodexUsageWindowKind {
  if (windowMinutes === 300) return 'five_hour';
  if (windowMinutes === 10080) return 'weekly';
  return 'unknown';
}

function formatCodexWindowKind(window: CodexUsageWindow): string {
  if (window.kind === 'five_hour') return '5-hour';
  if (window.kind === 'weekly') return 'weekly';
  return window.windowMinutes ? `${window.windowMinutes}-minute` : 'usage';
}

function readUsageCache(cwd: string, agent: 'claude'): NormalizedUsageStatus | null {
  const cachePath = getUsageCachePath(cwd);
  try {
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Partial<NormalizedUsageStatus>;
    if (parsed.agent !== agent || !parsed.fetchedAt) return null;
    return parsed as NormalizedUsageStatus;
  } catch {
    return null;
  }
}

function writeUsageCache(cwd: string, status: NormalizedUsageStatus): void {
  const cachePath = getUsageCachePath(cwd);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(status, null, 2), 'utf8');
}

function isUsageCacheFresh(status: NormalizedUsageStatus, config: RelayConfig): boolean {
  const fetched = Date.parse(status.fetchedAt);
  if (!Number.isFinite(fetched)) return false;

  const maxPercent = Math.max(
    status.fiveHourPercent ?? 0,
    status.weeklyPercent ?? 0,
    status.extraUsagePercent ?? 0,
  );
  const ttl = maxPercent >= config.usage_cache.near_limit_percent
    ? config.usage_cache.near_limit_ttl_ms
    : config.usage_cache.safe_ttl_ms;

  return Date.now() - fetched < ttl;
}

function markCacheAge(status: NormalizedUsageStatus): NormalizedUsageStatus {
  const fetched = Date.parse(status.fetchedAt);
  const stale = !Number.isFinite(fetched) || fetched <= Date.now() - 30 * 1000;
  return {
    ...status,
    cacheStatus: stale ? 'stale' : 'fresh',
    stale,
  };
}

async function fetchClaudeOAuthUsage(
  config: RelayConfig,
  thresholdPercent: number,
): Promise<NormalizedUsageStatus> {
  const credentialsPath = expandHome(config.usage_sources.claude.oauth_credentials_path);
  const token = readClaudeAccessToken(credentialsPath);
  if (!token) {
    throw new Error(`Claude OAuth access token not found at ${credentialsPath}`);
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Claude usage API returned HTTP ${response.status}`);
  }

  const raw = await response.json() as ClaudeOAuthUsageResponse;
  return evaluateUsageThreshold({
    agent: 'claude',
    source: 'claude-oauth',
    fetchedAt: new Date().toISOString(),
    cacheStatus: 'fresh',
    fiveHourPercent: asNumber(raw.five_hour?.utilization),
    weeklyPercent: asNumber(raw.seven_day?.utilization),
    extraUsagePercent: asNumber(raw.extra_usage?.utilization),
    fiveHourResetsAt: asString(raw.five_hour?.resets_at),
    weeklyResetsAt: asString(raw.seven_day?.resets_at),
    triggered: false,
  }, thresholdPercent);
}

function readClaudeAccessToken(credentialsPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown };
      accessToken?: unknown;
    };
    const token = parsed.claudeAiOauth?.accessToken ?? parsed.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function evaluateUsageThreshold(
  status: NormalizedUsageStatus,
  thresholdPercent: number,
): NormalizedUsageStatus {
  const candidates = [
    { label: '5-hour', percent: status.fiveHourPercent },
    { label: 'weekly', percent: status.weeklyPercent },
    { label: 'extra', percent: status.extraUsagePercent },
  ].filter((entry): entry is { label: string; percent: number } => typeof entry.percent === 'number');

  const hit = candidates
    .filter(({ percent }) => percent >= thresholdPercent)
    .sort((a, b) => b.percent - a.percent)[0];

  if (!hit) {
    return { ...status, triggered: false, triggerReason: undefined };
  }

  return {
    ...status,
    triggered: true,
    triggerReason: `Claude ${hit.label} usage is ${hit.percent.toFixed(0)}%`,
  };
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface ClaudeOAuthUsageResponse {
  five_hour?: {
    utilization?: unknown;
    resets_at?: unknown;
  };
  seven_day?: {
    utilization?: unknown;
    resets_at?: unknown;
  };
  extra_usage?: {
    utilization?: unknown;
  };
}

interface CodexRateLimitsPayload {
  limit_id?: string | null;
  limit_name?: string | null;
  primary?: CodexRateLimitWindowPayload | null;
  secondary?: CodexRateLimitWindowPayload | null;
  credits?: unknown;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}

interface CodexRateLimitWindowPayload {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

