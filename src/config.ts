import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import type { BatonConfig } from './types.js';

const DEFAULT_CONFIG: BatonConfig = {
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
  storage: {
    state_root: defaultStateRoot(),
    config_root: defaultConfigRoot(),
    project_id_strategy: 'slug_hash',
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
  handoff_dir: 'handoffs',
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

export function getBatonDir(cwd: string = process.cwd()): string {
  return getProjectStateDir(cwd);
}

export function getConfigPath(cwd: string = process.cwd()): string {
  const projectConfigPath = getProjectConfigPath(cwd);
  return fs.existsSync(projectConfigPath) ? projectConfigPath : getGlobalConfigPath();
}

export function getHandoffDir(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  return path.isAbsolute(cfg.handoff_dir)
    ? cfg.handoff_dir
    : path.join(getProjectStateDir(cwd), cfg.handoff_dir);
}

export function getWatchStatePath(cwd: string = process.cwd()): string {
  return path.join(getBatonDir(cwd), 'watch-state.json');
}

export function getStatusPath(cwd: string = process.cwd()): string {
  return path.join(getBatonDir(cwd), 'status.json');
}

export function getUsageCachePath(cwd: string = process.cwd()): string {
  return path.join(getBatonDir(cwd), 'usage-cache.json');
}

export function loadConfig(cwd: string = process.cwd()): BatonConfig {
  const globalRaw = readJsonFile(getGlobalConfigPath());
  const projectRaw = readJsonFile(getProjectConfigPath(cwd));
  const globalConfig = normalizeConfig(deepMerge(DEFAULT_CONFIG, globalRaw ?? {}) as BatonConfig, globalRaw ?? {});
  const merged = deepMerge(globalConfig, projectRaw ?? {}) as BatonConfig;
  return normalizeConfig(merged, projectRaw ?? {});
}

export function getUsageLimitPercent(config: BatonConfig): number {
  return config.limits.handoff_percent;
}

export function saveConfig(config: Partial<BatonConfig>, cwd: string = process.cwd()): void {
  const dir = getGlobalConfigRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadGlobalConfig();
  const merged = deepMerge(existing, config);
  fs.writeFileSync(getGlobalConfigPath(), JSON.stringify(merged, null, 2), 'utf8');
}

export function ensureBatonDirs(cwd: string = process.cwd()): void {
  const dirs = [
    getBatonDir(cwd),
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

export function getGlobalConfigRoot(): string {
  return expandHome(process.env.AGENT_BATON_CONFIG_HOME ?? DEFAULT_CONFIG.storage.config_root);
}

export function getGlobalConfigPath(): string {
  return path.join(getGlobalConfigRoot(), 'config.json');
}

export function getProjectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.baton', 'config.json');
}

export function getProjectStateDir(cwd: string = process.cwd()): string {
  const cfg = loadConfigWithoutProjectState(cwd);
  const root = expandHome(process.env.AGENT_BATON_STATE_HOME ?? cfg.storage.state_root);
  return path.join(root, 'projects', getProjectId(cwd));
}

export function getProjectId(cwd: string = process.cwd()): string {
  const resolved = resolveProjectPath(cwd);
  const slugBase = resolved
    .replace(/^[A-Za-z]:/, match => match.toLowerCase().replace(':', ''))
    .replace(/^[/\\]+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'project';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 10);
  return `${slugBase}-${hash}`;
}

function normalizeConfig(config: BatonConfig, raw: unknown): BatonConfig {
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

  if (config.storage.project_id_strategy !== 'slug_hash') {
    config.storage.project_id_strategy = DEFAULT_CONFIG.storage.project_id_strategy;
  }

  return config;
}

function loadConfigWithoutProjectState(cwd: string): BatonConfig {
  const globalRaw = readJsonFile(getGlobalConfigPath());
  const projectRaw = readJsonFile(getProjectConfigPath(cwd));
  const globalConfig = normalizeConfig(deepMerge(DEFAULT_CONFIG, globalRaw ?? {}) as BatonConfig, globalRaw ?? {});
  const merged = deepMerge(globalConfig, projectRaw ?? {}) as BatonConfig;
  return normalizeConfig(merged, projectRaw ?? {});
}

function loadGlobalConfig(): BatonConfig {
  const globalRaw = readJsonFile(getGlobalConfigPath());
  const merged = deepMerge(DEFAULT_CONFIG, globalRaw ?? {}) as BatonConfig;
  return normalizeConfig(merged, globalRaw ?? {});
}

function readJsonFile(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function defaultConfigRoot(): string {
  if (process.env.AGENT_BATON_CONFIG_HOME) return process.env.AGENT_BATON_CONFIG_HOME;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'agent-baton');
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'agent-baton');
  return '~/.config/agent-baton';
}

function defaultStateRoot(): string {
  if (process.env.AGENT_BATON_STATE_HOME) return process.env.AGENT_BATON_STATE_HOME;
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'agent-baton');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'agent-baton', 'state');
  return '~/.local/state/agent-baton';
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveProjectPath(cwd: string): string {
  const absolute = path.resolve(cwd);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
