/**
 * relay init
 *
 * Bootstrap relay for usage-limit handoffs in the current project.
 * Claude usage-limit hooks run relay guard directly.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { ensureRelayDirs, saveConfig, getRelayDir } from '../config.js';
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
    '# agent-relay internals (handoffs are committed, internals are not)',
    '.relay/watch-state.json',
    '.relay/status.json',
    '.relay/usage-cache.json',
    '.relay/pending-transfer.json',
    '.relay/config.json',
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
  const command = 'relay guard --from claude --hook';

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

function firstCommand(group: Record<string, unknown>): string | undefined {
  const hooks = group.hooks;
  if (!Array.isArray(hooks)) return undefined;
  const first = hooks[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const command = (first as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

export async function runInit(cwd: string): Promise<void> {
  console.log(chalk.bold('\nrelay init\n'));

  ensureRelayDirs(cwd);
  saveConfig({}, cwd);
  console.log(chalk.green('✓') + ` Created ${getRelayDir(cwd)}/`);

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

  console.log(chalk.bold('\nSetup complete!\n'));
  console.log('Useful commands:');
  console.log(`  ${chalk.cyan('relay usage --from claude')}  — inspect Claude usage cache/API status`);
  console.log(`  ${chalk.cyan('relay watch --from codex')}   — monitor Codex rollout usage limits`);
  console.log(`  ${chalk.cyan('relay pickup')}               — transfer to another agent when a handoff is ready`);
  console.log('');
}
