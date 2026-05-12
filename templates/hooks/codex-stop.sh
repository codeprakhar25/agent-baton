#!/usr/bin/env bash
# Relay hook for Codex — fires on the `Stop` event after each agent turn.
# Installed by `relay init` into .codex/hooks.json

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

echo "$INPUT" | "$RELAY" check --from codex --event stop
