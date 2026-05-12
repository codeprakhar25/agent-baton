#!/usr/bin/env bash
# Relay hook for Claude Code — fires on the `Stop` event after each agent turn.
# Installed by `relay init` into .claude/hooks.json
#
# Claude Code hooks receive JSON on stdin and the response JSON controls:
#   - {} — no-op, agent continues
#   - {"followup_message": "..."} — Claude will act on this as a new user message
#   - {"decision": "block", "reason": "..."} — stops the session with the reason shown

set -euo pipefail

INPUT=$(cat)

if ! command -v relay &>/dev/null; then
  RELAY_BIN="$(git rev-parse --show-toplevel 2>/dev/null)/node_modules/.bin/relay"
  if [[ ! -x "$RELAY_BIN" ]]; then
    echo '{}'
    exit 0
  fi
  RELAY="$RELAY_BIN"
else
  RELAY="relay"
fi

echo "$INPUT" | "$RELAY" check --from claude --event stop
