/**
 * relay statusline --from <agent>
 *
 * The ONLY reliable source of context_window.used_percentage.
 * Hook payloads across all agents never include context data — only the
 * StatusLine mechanism does (Claude Code settings.json "statusLine",
 * Cursor equivalent).
 *
 * On every turn this command:
 * 1. Reads context % from stdin JSON
 * 2. Writes .relay/context-state.json (read by check + pretool)
 * 3. Sets/clears .relay/danger-zone flag file (fast check for pretool)
 * 4. Returns { text: "relay:87% ⚠️" } for status bar display
 *
 * Install: add to .claude/settings.json → { "statusLine": "relay statusline --from claude" }
 */

import fs from 'fs';
import type { AgentName, StatusLinePayload, RelayConfig } from '../types.js';
import {
  loadConfig, getRelayDir, writeContextState, setDangerZone,
} from '../config.js';

export async function runStatusLine(agent: AgentName, cwd: string): Promise<void> {
  const raw = await readStdin();
  let payload: StatusLinePayload = {};

  try { payload = JSON.parse(raw); } catch { /* treat as empty */ }

  const cfg = loadConfig(cwd);
  const usedPct = payload.context_window?.used_percentage ?? null;

  if (usedPct === null) {
    respond({ text: '' });
    return;
  }

  // Write state so check + pretool can read it without context data in their payloads
  writeContextState(cwd, {
    agent,
    pct: usedPct,
    sessionId: payload.session_id,
    updatedAt: new Date().toISOString(),
  });

  // Set danger-zone flag when approaching warn threshold — pretool checks this first
  const warnThreshold = cfg.dev?.force_threshold ?? cfg.thresholds.warn_percent;
  setDangerZone(cwd, usedPct >= warnThreshold);

  respond({ text: buildStatusText(usedPct, cfg) });
}

function buildStatusText(pct: number, cfg: RelayConfig): string {
  const f = cfg.dev?.force_threshold ?? null;
  const handoff = f ?? cfg.thresholds.handoff_percent;
  const prepare = f ?? cfg.thresholds.prepare_percent;
  const warn    = f ?? cfg.thresholds.warn_percent;

  if (pct >= handoff) return `relay:${pct.toFixed(0)}% 🚨`;
  if (pct >= prepare) return `relay:${pct.toFixed(0)}% ⚠️`;
  if (pct >= warn)    return `relay:${pct.toFixed(0)}% ⚡`;
  return `relay:${pct.toFixed(0)}%`;
}

function respond(out: { text: string }): void {
  process.stdout.write(JSON.stringify(out) + '\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.readable || process.stdin.readableEnded) { resolve(''); return; }
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 2000);
  });
}
