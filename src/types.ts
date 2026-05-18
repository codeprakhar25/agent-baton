export type AgentName = 'cursor' | 'claude' | 'codex' | 'gemini';
export type UsageWindowName = 'five_hour' | 'weekly' | 'extra' | 'unknown';

export interface UsageWindowLimit {
  enabled: boolean;
  handoff_percent: number;
}

export type AgentUsageWindowLimits = Partial<Record<UsageWindowName, UsageWindowLimit>>;

export interface BatonConfig {
  agents: {
    cursor: AgentConfig;
    claude: AgentConfig;
    codex: AgentConfig;
    gemini: AgentConfig;
  };
  /** Legacy threshold config. Prefer limits.windows. */
  thresholds: {
    /** Legacy handoff threshold when subscription rate limit exceeds this % */
    rate_limit_percent: number;
  };
  limits: {
    /** ask: prompt agent/user choice; auto_handoff: write handoff; warn_only: notify without blocking */
    mode: 'ask' | 'auto_handoff' | 'warn_only';
    /** Legacy fallback percentage used when a per-window policy is missing */
    handoff_percent: number;
    /** Automatically write a handoff when transcript text shows an actual hard limit */
    auto_handoff_on_hard_limit: boolean;
    /** How many percent below handoff_percent to start warning (warn_at = handoff_percent - this) */
    warning_buffer_percent: number;
    /** Per-agent usage window thresholds */
    windows: {
      claude: AgentUsageWindowLimits;
      codex: AgentUsageWindowLimits;
    };
  };
  storage: {
    /** Runtime state root; relative paths are expanded from the user home */
    state_root: string;
    /** Config root; relative paths are expanded from the user home */
    config_root: string;
    /** Project subdirectory naming strategy */
    project_id_strategy: 'slug_hash';
  };
  usage_cache: {
    /** Cache TTL when usage is far from the warning band */
    safe_ttl_ms: number;
    /** Percentage where the shorter approach TTL starts */
    approach_percent: number;
    /** Cache TTL when usage is in the approach zone (approach_percent to warn_at) */
    approach_ttl_ms: number;
    /** Cache TTL when usage is in the warning band (>= warn_at) */
    near_limit_ttl_ms: number;
    /** Legacy: start refreshing more aggressively at this percentage */
    near_limit_percent: number;
    /** Min interval between fresh API fetches triggered by PreToolUse hooks */
    pretool_ttl_ms: number;
    /** Min interval before re-notifying the user after they chose to continue */
    notify_cooldown_ms: number;
  };
  usage_sources: {
    claude: {
      /** Claude Code OAuth credentials path */
      oauth_credentials_path: string;
    };
  };
  handoff_dir: string;
  handoff_extraction: {
    /** Max lines of transcript to extract for usage-limit handoffs */
    max_transcript_lines: number;
    /** Include full git diff in handoff (can be large) */
    include_git_diff: boolean;
    /** Max chars for git diff before it gets truncated */
    max_diff_chars: number;
    /** Strip secrets (API keys, tokens) from handoff */
    scan_secrets: boolean;
  };
  watch: {
    /** How often watch daemon polls usage sources (ms) */
    poll_interval_ms: number;
  };
}

export interface AgentConfig {
  enabled: boolean;
  /** Lower number = higher priority for receiving handoffs */
  priority: number;
  /** Path to CLI binary, defaults to agent name */
  bin?: string;
}

export interface GitState {
  branch: string;
  status: string;
  modifiedFiles: string[];
  untrackedFiles: string[];
  diff: string;
  diffStat: string;
  recentCommits: string;
  hasUncommittedChanges: boolean;
}

export interface TranscriptEntry {
  type: string;
  role?: string;
  content?: string | ContentBlock[];
  timestamp?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  error?: string;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
}

export interface ExtractedSession {
  agent: AgentName;
  sessionId?: string;
  transcriptPath?: string;
  lastUserMessage?: string;
  lastAssistantSummary?: string;
  recentToolCalls: ToolCallSummary[];
  taskDescription?: string;
  progressItems: string[];
  errors: string[];
  /** Raw tail of transcript for handoff recovery */
  transcriptTail: string;
}

export interface ToolCallSummary {
  tool: string;
  input: string;
  result?: string;
  failed?: boolean;
}

export interface HandoffDocument {
  id: string;
  timestamp: string;
  fromAgent: AgentName;
  reason: 'rate_limit' | 'manual';
  git: GitState;
  session: ExtractedSession;
  taskDescription: string;
  progressItems: string[];
  keyDecisions: string[];
  modifiedFiles: string[];
  currentState: string;
  /** Complete Markdown handoff written by the handing-off agent. */
  agentAuthoredMarkdown?: string;
  /** Original path of the agent-authored handoff before Baton registered it. */
  sourceHandoffPath?: string;
  /** Deprecated: brief human-authored summary written by the handing-off agent. */
  agentNote?: string;
  errors: string[];
  handoffFilePath?: string;
}

export interface RateLimitStatus {
  agent: AgentName;
  available: boolean;
  fiveHourPercent?: number;
  weeklyPercent?: number;
  subscriptionPercent?: number;
  resetIn?: string;
}

export interface NormalizedUsageStatus {
  agent: AgentName;
  source: string;
  fetchedAt: string;
  cacheStatus: 'fresh' | 'stale' | 'miss';
  fiveHourPercent?: number;
  weeklyPercent?: number;
  extraUsagePercent?: number;
    fiveHourResetsAt?: string;
  weeklyResetsAt?: string;
  triggered: boolean;
  triggerReason?: string;
  stale?: boolean;
}

export interface WatchState {
  /** PID of the watched agent process */
  pid?: number;
  agent: AgentName;
  transcriptPath: string;
  lastSeenBytes: number;
  lastSeenAt: number;
  cwd: string;
}

export interface NotificationState {
  /** When the user was first notified upon entering the warning band */
  warningBandNotifiedAt: string | null;
  warningBandPercent: number | null;
  /** When the user was first notified upon crossing the hard handoff threshold */
  thresholdNotifiedAt: string | null;
  thresholdPercent: number | null;
  /** Most recent notification timestamp — used for cooldown */
  lastNotifiedAt: string | null;
  lastNotifiedPercent: number | null;
  /** Last time a PreToolUse hook triggered a fresh fetch */
  preToolLastFetchAt: string | null;
}
