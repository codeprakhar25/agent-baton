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

/** Cap each file's diff section individually, preserving all file headers */
function capDiffPerFile(rawDiff: string, maxPerFile: number): string {
  if (!rawDiff) return '';
  const sections = rawDiff.split(/(?=^diff --git )/m);
  return sections.map(s =>
    s.length <= maxPerFile ? s
      : s.slice(0, maxPerFile) + `\n... [file diff truncated — run \`git diff HEAD\` for full diff]\n`,
  ).join('');
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
  const diff = capDiffPerFile(run('git diff HEAD', cwd), maxDiffChars);

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
