# agent-relay

Transfer work between AI coding agents — Claude Code, Cursor, Codex, and Gemini CLI — when one hits its usage limit.

When an agent hits its weekly or session usage limit mid-task, `relay` reads the agent's session files directly, extracts the task state, appends the current git diff, and hands everything to the next agent with a structured briefing.

---

## How it works

Agents write structured session logs (JSONL) as they work. When a usage limit is hit, `relay` reads those logs directly — no agent response required — and extracts:

- What the task was and what has been completed
- Which files were modified (committed and uncommitted)
- Recent tool calls and any errors encountered
- The full git diff so the next agent sees every change

This is written to a Markdown handoff file in `.relay/handoffs/`. Run `relay pickup` to choose the next agent and launch it with the handoff as its opening context.

**Why relay reads session files directly:** When an agent hits a hard usage limit, it cannot respond. The handoff must be extracted from session files by relay itself — the agent cannot write anything.

---

## Supported agents

| Agent | Session files | Hook events used |
|-------|--------------|-----------------|
| Claude Code | `~/.claude/projects/*/session.jsonl` | Stop, PreToolUse, PreCompact |
| Cursor | `~/.cursor/sessions/*/rollout.jsonl` | stop, preToolUse, preCompact |
| Codex | `~/.codex/sessions/**/*.jsonl` | Stop, PreToolUse, PreCompact |
| Gemini CLI | `~/.gemini/tmp/*/checkpoint.jsonl` | BeforeTool, AfterTool |

---

## Install

```bash
npm install -g agent-relay
```

Or build from source:

```bash
git clone https://github.com/codeprakhar25/agent-relay
cd agent-relay
npm install
npm run build
npm link
```

---

## Setup

Run once per project:

```bash
cd your-project
relay init
```

This detects which agents are installed, creates `.relay/` in your project, and installs hooks into each agent's config so `relay` is called automatically.

```
relay init

Detected agents: cursor, claude, codex, gemini

✓ Created .relay/
✓ cursor hook: installed
✓ claude hook: installed
✓ codex hook:  installed
✓ gemini hook: installed  (written to ~/.gemini/settings.json — global)
✓ Updated .gitignore
```

---

## Commands

### `relay handoff --from <agent>`

Manually capture the current task state and write a handoff file. Use at any time — no need to wait for a limit.

```bash
relay handoff --from claude
relay handoff --from cursor --launch   # also prompts to launch the next agent
```

### `relay pickup [--to <agent>]`

Choose the next agent and launch it with the handoff context. Shows an interactive picker if `--to` is omitted.

```bash
relay pickup               # interactive agent picker
relay pickup --to codex    # skip picker, launch codex directly
relay pickup --to gemini
```

### `relay watch --from <agent>`

Background safety-net daemon. Polls the agent's session file for signs of a hard stop — stale transcript, rate limit error patterns — and writes an emergency handoff if detected.

```bash
# Run in the background while your agent works
relay watch --from claude &
relay watch --from codex &
```

### `relay init`

Set up relay in the current project. Safe to re-run — skips hooks that are already installed.

```bash
relay init          # auto-detect agents and install hooks
relay init --force  # overwrite existing hooks
```

### `relay check --from <agent>`

Called automatically by agent stop hooks after each turn. Checks context state and injects warnings when approaching limits. You do not need to call this manually.

### `relay threshold <percent>` _(dev only)_

Override all context thresholds to a single value to test handoff flows without filling a real context window.

```bash
relay threshold 10          # all warning stages fire at 10% context
relay threshold --reset     # restore real thresholds (85 / 90 / 95%)
relay threshold             # show current override and real thresholds
```

---

## Typical workflow

```bash
# 1. Set up relay in your project
relay init

# 2. Start the safety-net daemon
relay watch --from claude &

# 3. Work normally. If claude hits a usage limit, relay writes a handoff automatically.
#    You'll see: [relay] Emergency handoff written: .relay/handoffs/HANDOFF-latest.md

# 4. Pick up the work in another agent
relay pickup
# → interactive picker: choose codex, cursor, or gemini
# → launches the agent with the handoff as its opening prompt
```

---

## Handoff document format

When a handoff is triggered, relay writes a Markdown file to `.relay/handoffs/`. The agent writes the narrative half; relay appends the technical half (git state, diff).

```markdown
# Relay Handoff: implement rate limit detection

## Task Description
Add regex-based rate limit detection to the watch daemon so relay can
detect when an agent has silently hit its usage quota.

## Progress
- [x] Created src/monitors/rate-limit.ts with pattern matching
- [x] Integrated into relay watch poll tick
- [ ] Write tests for pattern matching edge cases

## Key Decisions Made
- Used regex patterns over API calls — no auth required, works offline

## Current State
In src/commands/watch.ts at the tick() function. The readTailBytes()
helper still needs to be added — that is the immediate next step.

## Errors / Blockers
- None

---
## Git State (appended by relay)

**Branch:** `feat/rate-limit`  |  **Uncommitted changes:** Yes

### Modified Files
 M src/commands/watch.ts
 M src/monitors/rate-limit.ts

### Uncommitted Diff
(full diff follows)
```

---

## Configuration

`.relay/config.json` is created by `relay init`. Edit it directly to tune behaviour.

```json
{
  "agents": {
    "claude":  { "enabled": true, "priority": 2 },
    "cursor":  { "enabled": true, "priority": 1 },
    "codex":   { "enabled": true, "priority": 3 },
    "gemini":  { "enabled": true, "priority": 4 }
  },
  "thresholds": {
    "warn_percent":       85,
    "prepare_percent":    90,
    "handoff_percent":    95,
    "rate_limit_percent": 90
  },
  "handoff_dir": ".relay/handoffs",
  "context_extraction": {
    "max_transcript_lines": 100,
    "include_git_diff":     true,
    "max_diff_chars":       8000,
    "scan_secrets":         true
  },
  "watch": {
    "poll_interval_ms":   3000,
    "stale_threshold_ms": 15000
  }
}
```

**Agent priority** controls which agent is offered first in `relay pickup`. Lower number = higher priority.

---

## How `.relay/` is organized

```
.relay/
  config.json           — project config (gitignored)
  context-state.json    — latest context % from statusline (gitignored)
  pending-transfer.json — set when a handoff is ready (gitignored)
  watch-state.json      — daemon state (gitignored)
  handoffs/             — handoff documents — commit these
    HANDOFF-latest.md
    HANDOFF-2026-05-12T14-30-00Z.md
```

Handoff files are meant to be committed — they are the record of what was done and what comes next.

---

## Limitations

**Usage limits are reactive, not proactive.** None of the supported agents expose remaining billing quota as a local file or CLI flag. Relay detects usage limits by pattern-matching error messages that appear in session files when the limit is actually hit. Detection happens after the limit is reached, not before.

**Gemini transcript format varies.** Gemini CLI session file locations differ between versions. Relay scans `~/.gemini/tmp/` and `~/.gemini/sessions/`. If your version writes elsewhere, extraction falls back to git-state-only and the handoff will still contain the full diff but no conversation summary.

**Context window warnings are optional.** Relay includes a context-window detection tier (using each agent's StatusLine hook) that warns agents as they approach the token limit in the current conversation. This is separate from subscription limits. It requires configuring the `statusLine` setting in your agent's project config — `relay init` does this automatically.

**Cursor hook format is undocumented.** Cursor's hook API is not publicly documented and has changed between versions. If hooks stop firing after a Cursor update, re-run `relay init`.

---

## License

MIT — see [LICENSE](./LICENSE)
