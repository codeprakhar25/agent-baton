import fs from 'fs';
import path from 'path';
import type { ExtractedSession } from '../../types.js';
import { parseJsonlTail, buildSessionFromEntries } from './common.js';

/**
 * Cursor stores agent transcripts in .cursor/transcripts/ relative to the project.
 * Also checks the global Cursor data dir for any recent sessions.
 */
export function findCursorTranscripts(cwd: string): string[] {
  const projectTranscriptsDir = path.join(cwd, '.cursor', 'transcripts');
  const all: Array<{ file: string; mtime: number }> = [];

  if (fs.existsSync(projectTranscriptsDir)) {
    for (const f of fs.readdirSync(projectTranscriptsDir)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
      const fp = path.join(projectTranscriptsDir, f);
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

export function findActiveCursorTranscript(cwd: string): string | null {
  return findCursorTranscripts(cwd)[0] ?? null;
}

export function extractCursorSession(
  transcriptPath: string | null,
  cwd: string,
  maxLines = 100,
): ExtractedSession {
  const resolved = transcriptPath ?? findActiveCursorTranscript(cwd);

  if (!resolved) {
    return {
      agent: 'cursor',
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
  const firstEntry = entries[0];
  const sessionId = (firstEntry as Record<string, unknown>)?.session_id as string | undefined;

  return buildSessionFromEntries(entries, 'cursor', sessionId, resolved);
}
