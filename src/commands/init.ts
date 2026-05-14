/**
 * baton init
 *
 * Bootstrap baton for usage-limit handoffs in the current project.
 * Claude usage-limit hooks run baton guard directly.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { ensureBatonDirs, saveConfig, getBatonDir, getGlobalConfigPath } from '../config.js';
import type { AgentName } from '../types.js';

function detectAgents(cwd: string): AgentName[] {
  const detected: AgentName[] = [];

  if (fs.existsSync(path.join(cwd, '.cursor')) || isBinAvailable('cursor')) {
    detected.push('cursor');
  }
  if (isBinAvailable('claude') || fs.existsSync(path.join(cwd, '.claude'))) {
    detected.push('claude');
  }
  if (isBinAvailable('codex') || fs.existsSync(path.join(cwd, '.codex'))) {
    detected.push('codex');
  }
  if (isBinAvailable('gemini') || fs.existsSync(path.join(os.homedir(), '.gemini'))) {
    detected.push('gemini');
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

function updateGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entries = [
    '# agent-baton local overrides/hooks',
    '.baton/',
  ];

  let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const toAdd = entries.filter(e => !content.includes(e));

  if (toAdd.length) {
    content += '\n' + toAdd.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf8');
  }
}

function installClaudeUsageHooks(cwd: string): void {
  const claudeDir = path.join(cwd, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings = readJsonObject(settingsPath);
  const hooks = readJsonObjectValue(settings.hooks);
  const command = 'baton guard --from claude --hook';

  hooks.SessionStart = upsertHookGroup(hooks.SessionStart, {
    matcher: 'startup|resume',
    hooks: [{ type: 'command', command: `${command} --phase session-start` }],
  });
  hooks.UserPromptSubmit = upsertHookGroup(hooks.UserPromptSubmit, {
    hooks: [{ type: 'command', command: `${command} --phase prompt-submit` }],
  });
  hooks.PreToolUse = upsertHookGroup(hooks.PreToolUse, {
    matcher: 'Bash|Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: `${command} --phase pre-tool` }],
  });

  settings.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return readJsonObjectValue(parsed);
  } catch {
    return {};
  }
}

function readJsonObjectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function upsertHookGroup(existing: unknown, group: Record<string, unknown>): unknown[] {
  const groups = Array.isArray(existing) ? existing.filter(isHookGroup) : [];
  const command = firstCommand(group);
  const filtered = groups.filter(g => firstCommand(g) !== command);
  return [...filtered, group];
}

function isHookGroup(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installCodexUsageHooks(): void {
  const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  const existing = readJsonObject(hooksPath);
  const hooks = readJsonObjectValue(existing.hooks);

  const batonGuardCommand = 'baton guard --from codex --hook';
  const batonSessionCommand = 'baton guard --from codex --hook --phase session-start';

  // SessionStart: clear threshold-notified so each new session gets a fresh check.
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart as unknown[] : [];
  const hasSessionHook = sessionStart.some(
    g => isHookGroup(g) && firstCommand(g) === batonSessionCommand,
  );
  if (!hasSessionHook) {
    hooks.SessionStart = [
      ...sessionStart,
      { hooks: [{ type: 'command', command: batonSessionCommand, timeout: 10 }] },
    ];
  }

  // UserPromptSubmit: inject the usage warning once per session when threshold is crossed.
  const promptSubmit = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit as unknown[] : [];
  const hasPromptHook = promptSubmit.some(
    g => isHookGroup(g) && firstCommand(g) === batonGuardCommand,
  );
  if (!hasPromptHook) {
    hooks.UserPromptSubmit = [
      { hooks: [{ type: 'command', command: batonGuardCommand, timeout: 10 }] },
      ...promptSubmit,
    ];
  }

  existing.hooks = hooks;
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2), 'utf8');
}

function firstCommand(group: Record<string, unknown>): string | undefined {
  const hooks = group.hooks;
  if (!Array.isArray(hooks)) return undefined;
  const first = hooks[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const command = (first as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

export async function runInit(cwd: string): Promise<void> {
  console.log(chalk.bold('\nbaton init\n'));

  ensureBatonDirs(cwd);
  saveConfig({}, cwd);
  console.log(chalk.green('✓') + ` Created project state: ${getBatonDir(cwd)}/`);
  console.log(chalk.green('✓') + ` Wrote global config: ${getGlobalConfigPath()}`);

  const agents = detectAgents(cwd);
  if (agents.length) {
    console.log(`\nDetected agents: ${agents.map(a => chalk.cyan(a)).join(', ')}\n`);
  } else {
    console.log(chalk.yellow('\nNo agents detected (cursor, claude, codex, gemini).'));
  }

  if (fs.existsSync(path.join(cwd, '.git'))) {
    updateGitignore(cwd);
    console.log(chalk.green('✓') + ' Updated .gitignore');
  }

  installClaudeUsageHooks(cwd);
  console.log(chalk.green('✓') + ' Installed Claude usage-limit hooks');

  if (agents.includes('codex')) {
    installCodexUsageHooks();
    console.log(chalk.green('✓') + ' Installed Codex usage-limit hooks');
  }

  console.log(chalk.bold('\nSetup complete!\n'));
  console.log('Useful commands:');
  console.log(`  ${chalk.cyan('baton usage --from claude')}  — inspect Claude usage cache/API status`);
  console.log(`  ${chalk.cyan('baton codex')}                — preflight Codex usage before launching`);
  console.log(`  ${chalk.cyan('baton watch --from codex')}   — monitor Codex rollout usage limits`);
  console.log(`  ${chalk.cyan('baton pickup')}               — transfer to another agent when a handoff is ready`);
  console.log('');
}
