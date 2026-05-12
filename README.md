# agent-relay

Cross-agent handoff tool for Cursor, Claude Code, and Codex. When one agent hits its limit (context window or subscription), relay captures the full task context and transfers work to the next agent — no lost progress.

**Extended docs:** see the [wiki/](wiki/) (origin prompt, research, architecture, what was built, phases, usage). The Cursor plan file for this effort: `C:\Users\prakh\.cursor\plans\Agent Relay Tool-9f8b164f.plan.md` (plan id `9f8b164f`).

## How It Works

Two paths handle limit events:

**Clean path** (hooks detect threshold before limit hits):
```
Agent runs → hook fires on every turn → relay check reads context % →
  at 85%: tells agent "write a handoff file" → agent writes HANDOFF-latest.md →
  next hook fires → relay detects handoff written → blocks agent, shows transfer prompt →
  user runs relay pickup → selects next agent → next agent starts with handoff context
```

**Dirty path** (agent died mid-task, no clean exit):
```
relay watch --from cursor (running in background) →
  monitors transcript file size every 3s →
  transcript stale for 15s AND agent process gone →
  reads transcript tail + runs git diff →
  writes emergency HANDOFF with "INCOMPLETE" banner →
  prints transfer prompt in terminal →
  user runs relay pickup → continues with next agent
```

`git diff` is always the ground truth — even an emergency handoff tells the next agent exactly what files were changed, even if the context is incomplete.

## Install

```bash
cd agent-relay
npm install
npm run build
npm install -g .    # makes 'relay' available on PATH
```

## Setup

```bash
cd your-project
relay init          # creates .relay/, installs hooks in .cursor/ .claude/ .codex/
```

## Usage

```bash
# Start the background safety-net daemon (run in a separate terminal)
relay watch --from cursor

# When limit hits, relay shows a prompt. Then:
relay pickup                    # interactive: pick which agent to transfer to
relay pickup --to claude        # skip picker, go straight to claude

# Manual handoff (any time, not just at limit)
relay handoff --from cursor
relay handoff --from cursor --launch    # capture + immediately pick next agent
```

## Workflow

```
Terminal 1: your-agent running  (Cursor / Claude Code / Codex)
Terminal 2: relay watch --from cursor
```

When context hits 85% (configurable):
- If hooks are installed: the agent itself writes the handoff and relay shows the transfer prompt
- If the agent crashes: relay watch detects it within 15s and writes an emergency handoff

Then in any terminal:
```bash
relay pickup
```
```
? Transfer to which agent?
> claude  (priority 2)
  codex   (priority 3)
  Skip — just write the handoff, don't launch
```

The selected agent starts with a prompt directing it to read the handoff file and continue.

## Handoff File

Handoffs are written to `.relay/handoffs/HANDOFF-<timestamp>.md` and also copied to `.relay/handoffs/HANDOFF-latest.md`.

Example:
```markdown
# Relay Handoff: Refactor auth middleware to JWT

## Metadata
| From Agent | cursor |
| Reason     | Context window limit reached (91% used) |
| Git Branch | feature/auth-refactor |

## Progress
- [x] Rewrote token validation logic
- [x] Updated User model with refreshToken field
- [ ] Write migration script for existing sessions
- [ ] Add tests for token refresh flow

## Modified Files (uncommitted)
- `src/middleware/auth.ts` (modified)
- `src/models/user.ts` (modified)
...
```

## Config

`.relay/config.json` (created by `relay init`):

```json
{
  "thresholds": {
    "context_window_percent": 85,
    "rate_limit_percent": 90
  },
  "agents": {
    "cursor": { "enabled": true, "priority": 1 },
    "claude": { "enabled": true, "priority": 2 },
    "codex":  { "enabled": true, "priority": 3 }
  },
  "context_extraction": {
    "max_transcript_lines": 100,
    "include_git_diff": true,
    "max_diff_chars": 8000,
    "scan_secrets": true
  },
  "watch": {
    "poll_interval_ms": 3000,
    "stale_threshold_ms": 15000
  }
}
```

## The Mid-Task Collapse Problem

> "What if the agent is at 85% and in the next big task it collapses mid-turn at 100%?"

This is handled by `relay watch` (dirty path):

1. The hook fired at 85% → agent saw the `followup_message` → but started a new big task anyway
2. That task pushed context to 100% mid-turn → agent errored or auto-compacted
3. `relay watch` sees the transcript file stop growing
4. After 15 seconds of silence, it triggers emergency extraction:
   - Reads the last 100 lines of the JSONL transcript (last tool calls, messages)
   - Runs `git diff HEAD` — this is the **ground truth** of everything that changed
   - Writes an emergency handoff with the partial state
5. User runs `relay pickup` → next agent reads the handoff + git diff → continues

The git diff is why this works even with messy context — it shows exactly what was done regardless of how the agent exited.
