import fs from 'fs';
import path from 'path';
import type { RelayConfig } from './types.js';

const DEFAULT_CONFIG: RelayConfig = {
  agents: {
    cursor: { enabled: true, priority: 1 },
    claude: { enabled: true, priority: 2 },
    codex:  { enabled: true, priority: 3 },
  },
  thresholds: {
    context_window_percent: 85,
    rate_limit_percent: 90,
  },
  handoff_dir: '.relay/handoffs',
  context_extraction: {
    max_transcript_lines: 100,
    include_git_diff: true,
    max_diff_chars: 8000,
    scan_secrets: true,
  },
  watch: {
    poll_interval_ms: 3000,
    stale_threshold_ms: 15000,
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

export function loadConfig(cwd: string = process.cwd()): RelayConfig {
  const cfgPath = getConfigPath(cwd);
  if (!fs.existsSync(cfgPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return deepMerge(DEFAULT_CONFIG, raw) as RelayConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
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
