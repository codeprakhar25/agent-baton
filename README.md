# agent-baton

Don't lose your work when an AI coding agent hits its usage limit.

`baton` monitors usage for Claude Code and Codex, warns you before the threshold, and writes a rich Markdown handoff — transcript tail, task state, full git diff — so the next agent picks up exactly where you left off.

[![npm](https://img.shields.io/npm/v/@codeprakhar25/agent-baton)](https://www.npmjs.com/package/@codeprakhar25/agent-baton)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green)](package.json)

---

```
$ baton usage --from claude

  claude usage — 96% used
  ⚠  Near limit  (handoff threshold: 95%)
  Window resets in 44 min

---

  ⚠  Claude usage is at 96% — handoff threshold crossed.

  What do you want to do?

  › Continue  (use remaining quota, Claude will ask again on next prompt)
    Create handoff now  →  baton pickup
```

---

## The problem

You are deep in a task — three files modified, a bug half-fixed. Claude or Codex hits its hourly usage limit. You either:

- Lose track of what was in progress and start explaining from scratch in another agent.
- Manually copy-paste diffs and notes into a new session.

Baton fixes that. It intercepts at the threshold, gives you a choice, and writes a structured handoff that the next agent can read cold.

---

## Install

```bash
npm install -g @codeprakhar25/agent-baton
```

**Requirements:** Node.js 18+

---

## Quick Start

```bash
# 1. Initialize once per project
cd ~/your-project
baton init

# 2. Work normally — baton hooks into Claude automatically
#    For Codex, use the baton wrapper instead of running codex directly
baton codex "continue the auth refactor"

# 3. When baton warns you, choose: continue or hand off
#    If you choose handoff, pick up in the next agent
baton pickup --to codex
```

That's it. Every handoff is written to `~/.local/state/agent-baton/projects/<slug>/handoffs/` and never touches your repo.

---

## How It Works

Baton has two integration paths and one fallback:

**Claude Code** — `baton init` installs project hooks. On every session start, prompt submit, and tool call, `baton guard` reads cached usage. If you've crossed `limits.handoff_percent`, Claude is instructed to ask whether to continue or write a handoff. Tool calls are blocked until you choose.

**Codex** — `baton codex` wraps the `codex` binary. Usage is checked before Codex launches. If you're over the threshold, Baton asks whether to continue, create a handoff, or run `baton pickup`. Continuing injects a first prompt that tells Codex to ask before doing more work.

**Watch fallback** — `baton watch --from <agent>` monitors usage and scans transcripts for hard-limit errors (`usage limit`, `quota exceeded`, `429`). Writes a handoff automatically when `limits.auto_handoff_on_hard_limit` is true.

```
baton guard / baton codex / baton watch
          │
          ▼
    fetch usage (cached)
          │
     over threshold?
     ┌────┴────┐
    no         yes
     │          │
  allow     ask user
  work       │      │
          continue  handoff
                     │
              extract transcript tail
              + git branch/status/diff
                     │
              write HANDOFF-latest.md
                     │
              baton pickup --to <agent>
```

### Handoff format

Each handoff is a Markdown file with:

- Task description and recent transcript-derived state
- Recent tool calls and errors where extractable
- Git branch, status, diff stat, and last commits
- Full uncommitted diff (truncated at `handoff_extraction.max_diff_chars`)
- Instructions for the next agent

Git state is the durable source of truth — if transcript extraction is incomplete, the diff tells the full story.

```
~/.local/state/agent-baton/projects/<project-slug>-<hash>/
  handoffs/
    HANDOFF-latest.md      ← always points to the most recent
    HANDOFF-<timestamp>.md ← timestamped copy
  usage-cache.json
  pending-transfer.json
```

---

## Supported Agents

| Agent | Integration | Detection method |
|-------|-------------|-----------------|
| **Claude Code** | `SessionStart`, `UserPromptSubmit`, `PreToolUse` hooks | OAuth token → Claude usage API |
| **Codex** | `baton codex` wrapper | `~/.codex/sessions/**/rollout-*.jsonl` `token_count.rate_limits` events |
| **Cursor** | Watch / transcript fallback | Hard-limit error text in transcripts |
| **Gemini CLI** | Watch / transcript fallback | Hard-limit error text in transcripts |

Claude and Codex have proactive detection — Baton knows you're near the limit before it's actually hit. Cursor and Gemini rely on the hard-limit text appearing in transcripts.

---

## Commands

| Command | Description |
|---------|-------------|
| `baton init` | Install global config/state and Claude hooks for the current project |
| `baton usage --from <agent>` | Print current usage-limit status |
| `baton guard --from claude --hook` | Claude hook driver (called automatically) |
| `baton codex [-- <args>] [prompt]` | Launch Codex with usage preflight |
| `baton watch --from <agent>` | Monitor usage and hard-limit signals in the background |
| `baton handoff --from <agent>` | Manually write a handoff from the current transcript and git state |
| `baton pickup [--to <agent>]` | Launch an agent with a prompt pointing to the latest handoff |

```bash
# Check usage
baton usage --from claude
baton usage --from claude --json       # machine-readable
baton usage --from claude --refresh    # skip cache

# Codex wrapper
baton codex                            # bare launch with preflight
baton codex "finish the login flow"    # with initial prompt
baton codex -- --model o4-mini        # pass codex flags

# Handoff
baton handoff --from codex
baton handoff --from claude --reason rate-limit
baton handoff --from claude --launch   # write + immediately run pickup

# Pickup
baton pickup                           # choose agent interactively
baton pickup --to claude
baton pickup --to codex

# Watch (background, fallback path)
baton watch --from codex
baton watch --from cursor
```

---

## Configuration

Global config lives at:

```
~/.config/agent-baton/config.json
```

Per-project overrides (never committed):

```
.baton/config.json
```

`baton init` adds `.baton/` to `.gitignore` automatically.

```json
{
  "agents": {
    "cursor":  { "enabled": true, "priority": 1 },
    "claude":  { "enabled": true, "priority": 2 },
    "codex":   { "enabled": true, "priority": 3 },
    "gemini":  { "enabled": true, "priority": 4 }
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
  "handoff_dir": "handoffs",
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

**Key options:**

| Key | Default | Description |
|-----|---------|-------------|
| `limits.mode` | `"ask"` | `ask` — prompt before acting; `auto_handoff` — write immediately; `warn_only` — log only |
| `limits.handoff_percent` | `95` | Usage % that triggers the warning or handoff |
| `limits.auto_handoff_on_hard_limit` | `true` | Auto-write a handoff when hard-limit text appears |
| `usage_cache.safe_ttl_ms` | `900000` | Cache TTL (ms) when usage is below the near-limit band |
| `usage_cache.near_limit_ttl_ms` | `60000` | Cache TTL (ms) once usage is near the threshold |
| `handoff_extraction.max_diff_chars` | `8000` | Per-file diff truncation cap |

Environment overrides: `AGENT_BATON_CONFIG_HOME`, `AGENT_BATON_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`.

---

## Troubleshooting

**No Codex usage found**
Start or continue a Codex session so it emits `token_count.rate_limits` events into its rollout JSONL. Baton reads from `~/.codex/sessions/**/rollout-*.jsonl`.

**Claude usage unavailable**
Ensure Claude Code is OAuth-authenticated and `~/.claude/.credentials.json` exists. Run `baton usage --from claude --refresh` to force a fetch.

**Pickup says agent missing**
The target CLI is not on `PATH`. Install it or check your shell config.

**Hooks not firing**
Re-run `baton init` in the project directory. Check that `.claude/settings.json` contains the Baton guard hooks under `hooks`.

---

## Current Limits

- Context-window fullness is not monitored. Baton only handles usage-limit signals.
- Cursor and Gemini CLI have partial support — proactive detection requires hard-limit text to appear in transcripts.
- There is no automatic agent exit. Baton warns and writes the handoff; you exit the current agent and run `baton pickup` manually.

---

## License

MIT
