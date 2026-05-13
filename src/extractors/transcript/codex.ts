import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ExtractedSession } from '../../types.js';
import { parseJsonlTail, buildSessionFromEntries } from './common.js';

/**
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export function findCodexTranscripts(): string[] {
  const codexDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(codexDir)) return [];

  const all: Array<{ file: string; mtime: number }> = [];

  function walkDir(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fp = path.join(dir, entry);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) {
        walkDir(fp);
      } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
        all.push({ file: fp, mtime: stat.mtimeMs });
      }
    }
  }

  try {
    walkDir(codexDir);
  } catch { /* empty codex dir */ }

  return all
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.file);
}

export function findActiveCodexTranscript(): string | null {
  return findCodexTranscripts()[0] ?? null;
}

export function extractCodexSession(
  transcriptPath: string | null,
  maxLines = 100,
): ExtractedSession {
  const resolved = transcriptPath ?? findActiveCodexTranscript();

  if (!resolved) {
    return {
      agent: 'codex',
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
  // Codex rollout files often start with a summary header line
  const firstEntry = entries[0];
  const sessionId = (firstEntry as unknown as Record<string, unknown>)?.id as string | undefined;

  return buildSessionFromEntries(entries, 'codex', sessionId, resolved);
}
