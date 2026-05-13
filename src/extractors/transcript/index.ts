export { extractClaudeSession, findActiveClaudeTranscript, findClaudeTranscripts } from './claude.js';
export { extractCursorSession, findActiveCursorTranscript, findCursorTranscripts } from './cursor.js';
export { extractCodexSession, findActiveCodexTranscript, findCodexTranscripts } from './codex.js';
export { extractGeminiSession, findActiveGeminiTranscript, findGeminiTranscripts } from './gemini.js';

import type { AgentName, ExtractedSession } from '../../types.js';
import { extractClaudeSession } from './claude.js';
import { extractCursorSession } from './cursor.js';
import { extractCodexSession } from './codex.js';
import { extractGeminiSession } from './gemini.js';

export function extractSession(
  agent: AgentName,
  transcriptPath: string | null,
  cwd: string,
  maxLines = 100,
): ExtractedSession {
  switch (agent) {
    case 'claude': return extractClaudeSession(transcriptPath, cwd, maxLines);
    case 'cursor': return extractCursorSession(transcriptPath, cwd, maxLines);
    case 'codex':  return extractCodexSession(transcriptPath, maxLines);
    case 'gemini': return extractGeminiSession(transcriptPath, maxLines);
  }
}
