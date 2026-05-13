import { spawnSync, execSync } from 'child_process';
import path from 'path';
import type { AgentName } from '../types.js';

export interface LaunchOptions {
  cwd: string;
  handoffPath: string;
  /** Relative path from cwd to handoff file, for the prompt */
  relativeHandoffPath: string;
}

/** Check if an agent CLI is available on PATH */
export function isAgentAvailable(agent: AgentName): boolean {
  const bin = agentBin(agent);
  try {
    execSync(`which ${bin}`, { stdio: 'pipe' });
    return true;
  } catch {
    try {
      // Windows fallback
      execSync(`where ${bin}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

function agentBin(agent: AgentName): string {
  switch (agent) {
    case 'cursor': return 'cursor';
    case 'claude':  return 'claude';
    case 'codex':   return 'codex';
    case 'gemini':  return 'gemini';
  }
}

function buildPickupPrompt(relativeHandoffPath: string): string {
  return [
    `You are picking up a task from another AI agent.`,
    `Read the handoff document at \`${relativeHandoffPath}\` carefully before doing anything else.`,
    `It contains: the task description, what was completed, what remains, all file changes made so far, and explicit instructions.`,
    `Start by acknowledging the handoff: state what the remaining task is and what you will do first.`,
    `Then continue the work.`,
  ].join(' ');
}

/**
 * Launch an agent with the pickup prompt.
 * For Cursor and Claude this opens a new session with the prompt.
 * For Codex same approach.
 * All commands are printed first so the user can see what ran.
 */
export function launchAgent(agent: AgentName, opts: LaunchOptions): void {
  const prompt = buildPickupPrompt(opts.relativeHandoffPath);
  const bin = agentBin(agent);

  let args: string[];

  switch (agent) {
    case 'cursor':
      // cursor agent "prompt" -- starts a new agent session in the current dir
      args = ['agent', prompt];
      break;

    case 'claude':
      // claude --allowedTools "Read,Write,Shell,Glob,Grep,Bash" "prompt"
      args = [
        '--allowedTools', 'Read,Write,Shell,Glob,Grep,Bash',
        prompt,
      ];
      break;

    case 'codex':
      // codex "prompt"
      args = [prompt];
      break;

    case 'gemini':
      // gemini -p "prompt" for non-interactive session
      args = ['-p', prompt];
      break;
  }

  console.log(`\n$ ${bin} ${args.map(a => `"${a}"`).join(' ')}\n`);

  // Use spawnSync so the child process takes over the terminal
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    throw new Error(`Failed to launch ${agent}: ${result.error.message}`);
  }
}

/** Return the handoff path relative to cwd for embedding in prompts */
export function relativeHandoffPath(handoffPath: string, cwd: string): string {
  return path.relative(cwd, handoffPath);
}
