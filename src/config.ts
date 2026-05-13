import fs from 'fs';
import path from 'path';
import type { RelayConfig } from './types.js';

const DEFAULT_CONFIG: RelayConfig = {
  agents: {
    cursor: { enabled: true, priority: 1 },
    claude: { enabled: true, priority: 2 },
    codex:  { enabled: true, priority: 3 },
    gemini: { enabled: true, priority: 4 },
  },
  thresholds: {
    rate_limit_percent: 95,
  },
  limits: {
    mode: 'ask',
    handoff_percent: 95,
    auto_handoff_on_hard_limit: true,
  },
  usage_cache: {
    safe_ttl_ms: 15 * 60 * 1000,
    near_limit_ttl_ms: 60 * 1000,
    near_limit_percent: 75,
  },
  usage_sources: {
    claude: {
      oauth_credentials_path: '~/.claude/.credentials.json',
    },
  },
  handoff_dir: '.relay/handoffs',
  handoff_extraction: {
    max_transcript_lines: 100,
    include_git_diff: true,
    max_diff_chars: 8000,
    scan_secrets: true,
  },
  watch: {
    poll_interval_ms: 3000,
  },
};

export function getRelayDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.relay');
}

export function getConfigPath(cwd: string = process.cwd()): string {
  return path.join(getRelayDir(cwd), 'config.json');
}

export function getHandoffDir(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  return path.isAbsolute(cfg.handoff_dir)
    ? cfg.handoff_dir
    : path.join(cwd, cfg.handoff_dir);
}

export function getWatchStatePath(cwd: string = process.cwd()): string {
  return path.join(getRelayDir(cwd), 'watch-state.json');
}

export function getStatusPath(cwd: string = process.cwd()): string {
  return path.join(getRelayDir(cwd), 'status.json');
}

export function getUsageCachePath(cwd: string = process.cwd()): string {
  return path.join(getRelayDir(cwd), 'usage-cache.json');
}

export function loadConfig(cwd: string = process.cwd()): RelayConfig {
  const cfgPath = getConfigPath(cwd);
  if (!fs.existsSync(cfgPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return normalizeConfig(deepMerge(DEFAULT_CONFIG, raw) as RelayConfig, raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getUsageLimitPercent(config: RelayConfig): number {
  return config.limits.handoff_percent;
}

export function saveConfig(config: Partial<RelayConfig>, cwd: string = process.cwd()): void {
  const dir = getRelayDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadConfig(cwd);
  const merged = deepMerge(existing, config);
  fs.writeFileSync(getConfigPath(cwd), JSON.stringify(merged, null, 2), 'utf8');
}

export function ensureRelayDirs(cwd: string = process.cwd()): void {
  const dirs = [
    getRelayDir(cwd),
    getHandoffDir(cwd),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

export function getLatestHandoffPath(cwd: string = process.cwd()): string | null {
  const dir = getHandoffDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('HANDOFF-') && f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  return path.join(dir, files[0].name);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(base: any, override: any): any {
  if (typeof override !== 'object' || override === null) return override ?? base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] ?? {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function normalizeConfig(config: RelayConfig, raw: unknown): RelayConfig {
  const rawObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const rawLimits = typeof rawObject.limits === 'object' && rawObject.limits !== null && !Array.isArray(rawObject.limits)
    ? rawObject.limits as Record<string, unknown>
    : {};
  const rawThresholds = typeof rawObject.thresholds === 'object' && rawObject.thresholds !== null && !Array.isArray(rawObject.thresholds)
    ? rawObject.thresholds as Record<string, unknown>
    : {};

  if (typeof rawLimits.handoff_percent !== 'number' && typeof rawThresholds.rate_limit_percent === 'number') {
    config.limits.handoff_percent = rawThresholds.rate_limit_percent;
  }

  if (!['ask', 'auto_handoff', 'warn_only'].includes(config.limits.mode)) {
    config.limits.mode = DEFAULT_CONFIG.limits.mode;
  }

  if (!Number.isFinite(config.limits.handoff_percent)) {
    config.limits.handoff_percent = DEFAULT_CONFIG.limits.handoff_percent;
  }

  return config;
}
