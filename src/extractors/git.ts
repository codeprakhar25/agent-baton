import { execSync } from 'child_process';
import type { GitState } from '../types.js';

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function isGitRepo(cwd: string): boolean {
  return run('git rev-parse --git-dir', cwd) !== '';
}

export function captureGitState(cwd: string, maxDiffChars = 8000): GitState {
  if (!isGitRepo(cwd)) {
    return {
      branch: '(not a git repo)',
      status: '',
      modifiedFiles: [],
      untrackedFiles: [],
      diff: '',
      diffStat: '',
      recentCommits: '',
      hasUncommittedChanges: false,
    };
  }

  const branch = run('git branch --show-current', cwd) || run('git rev-parse --short HEAD', cwd);
  const statusRaw = run('git status --short', cwd);
  const diffStat = run('git diff --stat HEAD', cwd);
  let diff = run('git diff HEAD', cwd);

  if (diff.length > maxDiffChars) {
    diff = diff.slice(0, maxDiffChars) + `\n\n... [diff truncated at ${maxDiffChars} chars, run \`git diff HEAD\` for full diff]`;
  }

  const recentCommits = run('git log --oneline -8', cwd);

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of statusRaw.split('\n')) {
    if (!line.trim()) continue;
    const indicator = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    if (indicator === '??') {
      untrackedFiles.push(file);
    } else if (indicator) {
      modifiedFiles.push(file);
    }
  }

  const hasUncommittedChanges = modifiedFiles.length > 0 || untrackedFiles.length > 0;

  return {
    branch,
    status: statusRaw,
    modifiedFiles,
    untrackedFiles,
    diff,
    diffStat,
    recentCommits,
    hasUncommittedChanges,
  };
}
