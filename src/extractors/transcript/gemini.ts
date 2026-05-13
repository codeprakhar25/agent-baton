import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ExtractedSession } from '../../types.js';
import { parseJsonlTail, buildSessionFromEntries } from './common.js';

/**
 * Gemini CLI stores sessions at ~/.gemini/tmp/<session-id>/checkpoint.jsonl
 * or ~/.gemini/sessions/<session-id>/conversation.jsonl depending on version.
 * We scan both locations and pick the most recently modified file.
 */
export function findGeminiTranscripts(): string[] {
  const home = os.homedir();
  const searchDirs = [
    path.join(home, '.gemini', 'tmp'),
    path.join(home, '.gemini', 'sessions'),
  ];

  const all: Array<{ file: string; mtime: number }> = [];

  for (const base of searchDirs) {
    if (!fs.existsSync(base)) continue;
    try {
      for (const entry of fs.readdirSync(base)) {
        const sessionDir = path.join(base, entry);
        if (!fs.statSync(sessionDir).isDirectory()) continue;
        for (const fname of ['checkpoint.jsonl', 'conversation.jsonl']) {
          const fp = path.join(sessionDir, fname);
          if (fs.existsSync(fp)) {
            all.push({ file: fp, mtime: fs.statSync(fp).mtimeMs });
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  return all.sort((a, b) => b.mtime - a.mtime).map(x => x.file);
}

export function findActiveGeminiTranscript(): string | null {
  return findGeminiTranscripts()[0] ?? null;
}

export function extractGeminiSession(
  transcriptPath: string | null,
  maxLines = 100,
): ExtractedSession {
  const resolved = transcriptPath ?? findActiveGeminiTranscript();

  if (!resolved) {
    return {
      agent: 'gemini',
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
  return buildSessionFromEntries(entries, 'gemini', undefined, resolved);
}
