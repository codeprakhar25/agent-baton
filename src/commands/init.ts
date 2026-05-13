/**
 * relay init
 *
 * Entry point for the `relay init` CLI command. Run once per project to bootstrap
 * the relay infrastructure. Auto-detects which AI coding agents are installed
 * (Cursor, Claude Code, Codex) by checking for their binaries and config directories,
 * then wires up a stop-hook in each so relay can intercept agent handoffs automatically.
 *
 * Sets up relay in the current working directory:
 * 1. Creates .relay/ and .relay/handoffs/ directories
 * 2. Writes .relay/config.json with defaults
 * 3. Installs hooks into detected agents (.cursor/hooks.json, .claude/hooks.json, .codex/hooks.json)
 * 4. Adds .relay/ to .gitignore (except handoffs, which should be committed)
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { ensureRelayDirs, saveConfig, getRelayDir } from '../config.js';
import type { AgentName } from '../types.js';

type HookInstallResult = { agent: AgentName; status: 'installed' | 'updated' | 'skipped'; note?: string };

function detectAgents(cwd: string): AgentName[] {
  const detected: AgentName[] = [];

  // Cursor: detect by presence of .cursor/ dir or cursor binary
  if (fs.existsSync(path.join(cwd, '.cursor')) || isBinAvailable('cursor')) {
    detected.push('cursor');
  }

  // Claude Code: detect by claude binary or .claude/ dir
  if (isBinAvailable('claude') || fs.existsSync(path.join(cwd, '.claude'))) {
    detected.push('claude');
  }

  // Codex: detect by codex binary
  if (isBinAvailable('codex') || fs.existsSync(path.join(cwd, '.codex'))) {
    detected.push('codex');
  }

  return detected;
}

function isBinAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function relayBinPath(): string {
  // The relay binary - after npm install it's at relay, otherwise node path
  return 'relay';
}

function mergeHook(
  hooks: Record<string, unknown[]>,
  eventKey: string,
  newHook: Record<string, unknown>,
  matchStr: string,
): boolean {
  const existing: unknown[] = (hooks[eventKey] as unknown[]) ?? [];
  const alreadyIn = existing.some(
    h => typeof h === 'object' && h !== null &&
         (h as Record<string, unknown>).command?.toString().includes(matchStr)
  );
  if (alreadyIn) return false;
  hooks[eventKey] = [...existing, newHook];
  return true;
}

function installCursorHook(cwd: string): HookInstallResult {
  const hooksDir = path.join(cwd, '.cursor');
  const hooksFile = path.join(hooksDir, 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });

  let existing: Record<string, unknown> = { version: 1, hooks: {} };
  if (fs.existsSync(hooksFile)) {
    try { existing = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch { /* use default */ }
  }

  const hooks = (existing.hooks as Record<string, unknown[]>) ?? {};
  const bin = relayBinPath();
  let changed = false;

  // stop hook (check — reads from context-state written by statusline)
  changed = mergeHook(hooks, 'stop', { command: `${bin} check --from cursor --event stop`, timeout: 8 }, 'relay check') || changed;
  // preToolUse hook (mid-response gate — fast file-stat check)
  changed = mergeHook(hooks, 'preToolUse', { command: `${bin} pretool --from cursor`, timeout: 5 }, 'relay pretool') || changed;
  // preCompact hook (last-resort handoff before auto-compaction)
  changed = mergeHook(hooks, 'preCompact', { command: `${bin} precompact --from cursor`, timeout: 15 }, 'relay precompact') || changed;

  if (!changed) return { agent: 'cursor', status: 'skipped', note: 'hooks already present' };

  existing.hooks = hooks;
  fs.writeFileSync(hooksFile, JSON.stringify(existing, null, 2), 'utf8');

  // Install statusline config (separate from hooks)
  installCursorStatusLine(cwd, bin);

  return { agent: 'cursor', status: 'installed' };
}

function installCursorStatusLine(cwd: string, bin: string): void {
  const settingsFile = path.join(cwd, '.cursor', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* use default */ }
  }
  if (!settings.statusLine) {
    settings.statusLine = `${bin} statusline --from cursor`;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  }
}

function installClaudeHook(cwd: string): HookInstallResult {
  const hooksDir = path.join(cwd, '.claude');
  const hooksFile = path.join(hooksDir, 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });

  let existing: Record<string, unknown> = { hooks: {} };
  if (fs.existsSync(hooksFile)) {
    try { existing = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch { /* use default */ }
  }

  const hooks = (existing.hooks as Record<string, unknown[]>) ?? {};
  const bin = relayBinPath();
  const cmd = (command: string, timeout: number) => ({ type: 'command', command, timeout });
  let changed = false;

  changed = mergeHook(hooks, 'Stop', cmd(`${bin} check --from claude --event stop`, 8), 'relay check') || changed;
  changed = mergeHook(hooks, 'PreToolUse', cmd(`${bin} pretool --from claude`, 5), 'relay pretool') || changed;
  changed = mergeHook(hooks, 'PreCompact', cmd(`${bin} precompact --from claude`, 15), 'relay precompact') || changed;

  if (!changed) return { agent: 'claude', status: 'skipped', note: 'hooks already present' };

  existing.hooks = hooks;
  fs.writeFileSync(hooksFile, JSON.stringify(existing, null, 2), 'utf8');

  // Install statusline in project settings
  installClaudeStatusLine(cwd, bin);

  return { agent: 'claude', status: 'installed' };
}

function installClaudeStatusLine(cwd: string, bin: string): void {
  // Project-level Claude Code settings
  const settingsFile = path.join(cwd, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* use default */ }
  }
  if (!settings.statusLine) {
    settings.statusLine = `${bin} statusline --from claude`;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  }
}

function installCodexHook(cwd: string): HookInstallResult {
  const hooksDir = path.join(cwd, '.codex');
  const hooksFile = path.join(hooksDir, 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });

  let existing: Record<string, unknown> = { version: 1, hooks: {} };
  if (fs.existsSync(hooksFile)) {
    try { existing = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch { /* use default */ }
  }

  const hooks = (existing.hooks as Record<string, unknown[]>) ?? {};
  const bin = relayBinPath();
  let changed = false;

  // Codex 0.130.0+ supports PreToolUse, PreCompact (confirmed stable)
  // StatusLine: tui.status_line config exists but items undocumented — skip for now
  changed = mergeHook(hooks, 'Stop', { command: `${bin} check --from codex --event stop`, timeout: 8 }, 'relay check') || changed;
  changed = mergeHook(hooks, 'PreToolUse', { command: `${bin} pretool --from codex`, timeout: 5 }, 'relay pretool') || changed;
  changed = mergeHook(hooks, 'PreCompact', { command: `${bin} precompact --from codex`, timeout: 15 }, 'relay precompact') || changed;

  if (!changed) return { agent: 'codex', status: 'skipped', note: 'hooks already present' };

  existing.hooks = hooks;
  fs.writeFileSync(hooksFile, JSON.stringify(existing, null, 2), 'utf8');
  return { agent: 'codex', status: 'installed', note: 'statusline skipped (tui.status_line undocumented — probe first)' };
}

function updateGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entries = [
    '# agent-relay internals (handoffs are committed, internals are not)',
    '.relay/watch-state.json',
    '.relay/status.json',
    '.relay/pending-transfer.json',
    '.relay/config.json',
    '.relay/context-state.json',
    '.relay/danger-zone',
  ];

  let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

  const toAdd = entries.filter(e => !content.includes(e));
  if (toAdd.length) {
    content += '\n' + toAdd.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf8');
  }
}

export async function runInit(cwd: string, force = false): Promise<void> {
  console.log(chalk.bold('\nrelay init\n'));

  // 1. Create directories and default config
  ensureRelayDirs(cwd);
  saveConfig({}, cwd);
  console.log(chalk.green('✓') + ` Created ${getRelayDir(cwd)}/`);

  // 2. Detect agents
  const agents = detectAgents(cwd);
  if (!agents.length) {
    console.log(chalk.yellow('\nNo agents detected (cursor, claude, codex).'));
    console.log(chalk.gray('Install at least one agent and run relay init again, or add agents manually.'));
  } else {
    console.log(`\nDetected agents: ${agents.map(a => chalk.cyan(a)).join(', ')}\n`);
  }

  // 3. Install hooks
  const results: HookInstallResult[] = [];

  for (const agent of agents) {
    try {
      let result: HookInstallResult;
      switch (agent) {
        case 'cursor': result = installCursorHook(cwd); break;
        case 'claude': result = installClaudeHook(cwd); break;
        case 'codex':  result = installCodexHook(cwd);  break;
      }
      results.push(result);
    } catch (err) {
      results.push({ agent, status: 'skipped', note: `error: ${err}` });
    }
  }

  for (const r of results) {
    const icon = r.status === 'skipped' ? chalk.gray('~') : chalk.green('✓');
    const label = r.status === 'installed' ? chalk.green('installed') :
                  r.status === 'updated'   ? chalk.yellow('updated') :
                                              chalk.gray('skipped');
    console.log(`${icon} ${r.agent} hook: ${label}${r.note ? chalk.gray(` (${r.note})`) : ''}`);
  }

  // 4. Update .gitignore
  if (fs.existsSync(path.join(cwd, '.git'))) {
    updateGitignore(cwd);
    console.log(chalk.green('✓') + ' Updated .gitignore');
  }

  console.log(chalk.bold('\nSetup complete!\n'));
  console.log('Next steps:');
  console.log(`  ${chalk.cyan('relay watch --from cursor')}   — start the safety-net daemon`);
  console.log(`  ${chalk.cyan('relay pickup')}                — transfer to next agent when limit hits`);
  console.log(`  ${chalk.cyan('relay handoff --from cursor')} — manual handoff at any time`);
  console.log('');
}
