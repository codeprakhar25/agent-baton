import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ExtractedSession } from '../../types.js';
import { parseJsonlTail, buildSessionFromEntries } from './common.js';

/** Claude Code stores sessions at ~/.claude/projects/<hash>/sessions/<uuid>.jsonl */
export function findClaudeTranscripts(cwd: string): string[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  // Each subdirectory corresponds to a project (hashed path)
  const projectDirs = fs.readdirSync(claudeDir)
    .map(d => path.join(claudeDir, d))
    .filter(d => fs.statSync(d).isDirectory());

  const all: Array<{ file: string; mtime: number }> = [];

  for (const pd of projectDirs) {
    const sessionsDir = path.join(pd, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;

    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sessionsDir, f);
      try {
        const stat = fs.statSync(fp);
        all.push({ file: fp, mtime: stat.mtimeMs });
      } catch { /* skip */ }
    }
  }

  return all
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.file);
}

/** Find the most recently modified Claude transcript (likely the active session) */
export function findActiveClaudeTranscript(cwd: string): string | null {
  const transcripts = findClaudeTranscripts(cwd);
  return transcripts[0] ?? null;
}

export function extractClaudeSession(
  transcriptPath: string | null,
  cwd: string,
  maxLines = 100,
): ExtractedSession {
  const resolved = transcriptPath ?? findActiveClaudeTranscript(cwd);

  if (!resolved) {
    return {
      agent: 'claude',
      transcriptPath: undefined,
      lastUserMessage: undefined,
      lastAssistantSummary: undefined,
      recentToolCalls: [],
      progressItems: [],
      errors: [],
      transcriptTail: '',
    };
  }

  const entries = parseJsonlTail(resolved, maxLines);

  // Extract session ID from the first entry
  const firstEntry = entries[0];
  const sessionId = (firstEntry as unknown as Record<string, unknown>)?.sessionId as string | undefined;

  return buildSessionFromEntries(entries, 'claude', sessionId, resolved);
}
