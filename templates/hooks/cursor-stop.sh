#!/usr/bin/env bash
# Relay hook for Cursor — fires on the `stop` event after each agent turn.
# Installed by `relay init` into .cursor/hooks.json
#
# Reads the hook payload from stdin, forwards to `relay check`.
# If relay check returns a followup_message, Cursor asks the agent to write a handoff.
# If relay check returns a block decision, Cursor stops and shows the transfer prompt.

set -euo pipefail

INPUT=$(cat)

# relay must be on PATH (installed via npm install -g agent-relay)
if ! command -v relay &>/dev/null; then
  # Fallback: try running directly from project node_modules
  RELAY_BIN="$(git rev-parse --show-toplevel 2>/dev/null)/node_modules/.bin/relay"
  if [[ ! -x "$RELAY_BIN" ]]; then
    # relay not found — pass through silently (don't block agent)
    echo '{}'
    exit 0
  fi
  RELAY="$RELAY_BIN"
else
  RELAY="relay"
fi

echo "$INPUT" | "$RELAY" check --from cursor --event stop
