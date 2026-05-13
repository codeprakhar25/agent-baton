# agent-relay

Transfer work between AI coding agents when a usage limit is close to being reached.

`relay` checks agent usage-limit signals, writes a Markdown handoff with transcript and git state, then lets another agent continue from that handoff.

## Supported Signals

| Agent | Usage-limit source | Status |
|-------|--------------------|--------|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` `token_count.rate_limits` events | Implemented |
| Claude Code | `~/.claude/.credentials.json` OAuth token + Claude usage API | Implemented |
| Cursor | Transcript regex fallback for hard limit errors | Partial |
| Gemini CLI | Transcript regex fallback for hard limit errors | Partial |

This tool does not monitor context-window fullness and does not install context hooks. The Claude hooks are only usage-limit guards.

## Install

```bash
npm install
npm run build
npm link
```

## Setup

Run once per project:

```bash
relay init
```

This creates `.relay/`, writes `.relay/config.json`, updates `.gitignore`, and installs Claude project hooks that run `relay guard --from claude --hook`.

## Commands

### `relay usage --from <agent>`

Print current usage-limit status.

```bash
relay usage --from claude
relay usage --from claude --json
relay usage --from claude --refresh
relay usage --from codex
```

For Claude, `usage` reads `~/.claude/.credentials.json`, calls `https://api.anthropic.com/api/oauth/usage`, and caches normalized status in `.relay/usage-cache.json`.

### `relay guard --from claude --hook`

Command used by Claude hooks. `SessionStart` fetches Claude usage once and writes `.relay/usage-cache.json`. Prompt and tool hooks read only the cache; they do one confirmatory refresh only if cached usage has already crossed `thresholds.rate_limit_percent`, then block with a handoff.

Installed Claude hook events:

- `SessionStart` for `startup|resume`
- `UserPromptSubmit`
- `PreToolUse` for `Bash|Edit|Write|MultiEdit`

### `relay watch --from <agent>`

Run beside the active agent. It monitors usage limits and writes a handoff when the configured threshold is crossed.

```bash
relay watch --from codex
```

For Codex, `watch` reads the active rollout JSONL and checks:

- `primary.used_percent`
- `secondary.used_percent`
- `window_minutes: 300` as 5-hour
- `window_minutes: 10080` as weekly
- `rate_limit_reached_type`

For all agents, it also scans new transcript bytes for hard-limit errors such as `usage limit`, `quota exceeded`, and `429`. Claude should normally use the hook-driven `guard` path instead of `watch`.

### `relay handoff --from <agent> [--launch]`

Manually write a handoff from the current transcript and git state.

```bash
relay handoff --from codex
relay handoff --from claude --launch
```

### `relay pickup [--to <agent>]`

Launch another agent with a prompt that tells it to read `.relay/handoffs/HANDOFF-latest.md`.

```bash
relay pickup
relay pickup --to claude
relay pickup --to codex
```

### `relay init`

Create relay project files.

```bash
relay init
```

## Configuration

`.relay/config.json`:

```json
{
  "agents": {
    "cursor":  { "enabled": true, "priority": 1 },
    "claude":  { "enabled": true, "priority": 2 },
    "codex":   { "enabled": true, "priority": 3 },
    "gemini":  { "enabled": true, "priority": 4 }
  },
  "thresholds": {
    "rate_limit_percent": 95
  },
  "usage_cache": {
    "safe_ttl_ms": 900000,
    "near_limit_ttl_ms": 60000,
    "near_limit_percent": 75
  },
  "usage_sources": {
    "claude": {
      "oauth_credentials_path": "~/.claude/.credentials.json"
    }
  },
  "handoff_dir": ".relay/handoffs",
  "handoff_extraction": {
    "max_transcript_lines": 100,
    "include_git_diff": true,
    "max_diff_chars": 8000,
    "scan_secrets": true
  },
  "watch": {
    "poll_interval_ms": 3000
  }
}
```

## Handoff Files

Handoffs are written to:

```text
.relay/handoffs/
  HANDOFF-latest.md
  HANDOFF-<timestamp>.md
```

Each handoff includes task state from the transcript plus git status, diff stat, recent commits, and the uncommitted diff.

## Current Limits

- Claude proactive usage detection is hook-driven and uses Claude Code OAuth credentials.
- Codex proactive usage detection reads rollout JSONL events.
- Cursor and Gemini currently rely on hard-limit text appearing in transcripts.
- There is no context-window handoff path.
