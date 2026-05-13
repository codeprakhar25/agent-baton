# agent-relay

Transfer work between AI coding agents when a usage limit is close to being reached.

`relay` checks agent usage-limit signals, warns before the configured handoff point, and writes a Markdown handoff with transcript and git state when the user or configuration chooses a transfer.

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

Command used by Claude hooks. `SessionStart` fetches Claude usage once and writes `.relay/usage-cache.json`. Prompt and tool hooks read only the cache; they do one confirmatory refresh only if cached usage has already crossed `limits.handoff_percent`.

In the default `limits.mode: "ask"` mode:

- `UserPromptSubmit` adds context telling Claude to ask whether to continue or write a handoff.
- `PreToolUse` denies the tool call until Claude asks that same choice, so edits do not continue silently past the warning.
- Relay writes `.relay/pending-transfer.json` only when a handoff is actually created, for example with `relay handoff --from claude --reason rate-limit`.

Installed Claude hook events:

- `SessionStart` for `startup|resume`
- `UserPromptSubmit`
- `PreToolUse` for `Bash|Edit|Write|MultiEdit`

### `relay watch --from <agent>`

Run beside the active agent. It monitors usage limits and warns when the configured threshold is crossed. It writes a handoff automatically only in `limits.mode: "auto_handoff"` or when hard-limit text is detected and `limits.auto_handoff_on_hard_limit` is enabled.

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

### `relay codex [-- <codex args>] [prompt]`

Preflight Codex usage before launching Codex.

```bash
relay codex
relay codex "continue the current task"
relay codex -- --model gpt-5.1
```

If Codex usage is below `limits.handoff_percent`, Relay launches Codex normally. If usage is above the threshold, Relay asks whether to continue in Codex, create a handoff now, or run `relay pickup`. Continuing injects a first prompt warning Codex to ask the user before doing more work.

### `relay handoff --from <agent> [--reason <reason>] [--launch]`

Manually write a handoff from the current transcript and git state.

```bash
relay handoff --from codex
relay handoff --from claude --reason rate-limit
relay handoff --from claude --launch
```

Creating a handoff also writes `.relay/pending-transfer.json`, which `relay pickup` clears after launching the next agent.

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
  "limits": {
    "mode": "ask",
    "handoff_percent": 95,
    "auto_handoff_on_hard_limit": true
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

`thresholds.rate_limit_percent` is kept for older configs. New configs should use `limits.handoff_percent`.

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
