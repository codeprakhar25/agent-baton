export type AgentName = 'cursor' | 'claude' | 'codex' | 'gemini';

export interface RelayConfig {
  agents: {
    cursor: AgentConfig;
    claude: AgentConfig;
    codex: AgentConfig;
    gemini: AgentConfig;
  };
  thresholds: {
    /** Trigger handoff when subscription rate limit exceeds this % */
    rate_limit_percent: number;
  };
  usage_cache: {
    /** Cache TTL for manual/status lookups while usage is below the limit */
    safe_ttl_ms: number;
    /** Cache TTL once usage approaches the handoff threshold */
    near_limit_ttl_ms: number;
    /** Start refreshing more aggressively at this percentage */
    near_limit_percent: number;
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
