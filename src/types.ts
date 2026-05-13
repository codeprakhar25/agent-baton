export type AgentName = 'cursor' | 'claude' | 'codex' | 'gemini';

export type ThresholdStage = 'warn' | 'prepare' | 'handoff' | 'none';

export interface RelayConfig {
  agents: {
    cursor: AgentConfig;
    claude: AgentConfig;
    codex: AgentConfig;
    gemini: AgentConfig;
  };
  thresholds: {
    /** Soft warning — keep working but stay on current subtask */
    warn_percent: number;
    /** Wrap-up directive — finish current step and stop */
    prepare_percent: number;
    /** Handoff trigger — write handoff document now */
    handoff_percent: number;
    /** Trigger handoff when subscription rate limit exceeds this % */
    rate_limit_percent: number;
  };
  dev: {
    /** If set, overrides all three threshold checks with this single value (for testing) */
    force_threshold?: number;
  };
  handoff_dir: string;
  context_extraction: {
    /** Max lines of transcript to extract for emergency handoffs */
    max_transcript_lines: number;
    /** Include full git diff in handoff (can be large) */
    include_git_diff: boolean;
    /** Max chars for git diff before it gets truncated */
    max_diff_chars: number;
    /** Strip secrets (API keys, tokens) from handoff */
    scan_secrets: boolean;
  };
  watch: {
    /** How often watch daemon polls for dead sessions (ms) */
    poll_interval_ms: number;
    /** How long a transcript must be stale before we consider the session dead (ms) */
    stale_threshold_ms: number;
  };
}

export interface AgentConfig {
  enabled: boolean;
  /** Lower number = higher priority for receiving handoffs */
  priority: number;
  /** Path to CLI binary, defaults to agent name */
  bin?: string;
}

/** Payload that all three agent hooks send on stdin (unified shape) */
export interface HookPayload {
  /** From Cursor/Claude statusline spec */
  context_window?: {
    used_percentage: number | null;
    remaining_percentage: number | null;
    context_window_size: number | null;
    total_input_tokens: number | null;
  };
  /** Session metadata */
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  cwd?: string;
  model?: {
    id: string;
    display_name: string;
  };
}

/** What relay check returns to the hook (followup_message format) */
export interface HookResponse {
  followup_message?: string;
  decision?: 'block';
  reason?: string;
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
  /** Raw tail of transcript for emergency recovery */
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
  reason: 'context_window' | 'rate_limit' | 'emergency' | 'manual';
  contextPercent?: number;
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

/** Context usage state written by statusline, read by check/pretool */
export interface ContextState {
  agent: AgentName;
  pct: number;
  sessionId?: string;
  updatedAt: string;
}

/** Payload shape from StatusLine mechanism (superset of hook payload — includes context_window) */
export interface StatusLinePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  context_window?: {
    used_percentage: number | null;
    remaining_percentage: number | null;
    context_window_size: number | null;
    total_input_tokens: number | null;
  };
  model?: { id: string; display_name: string };
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
