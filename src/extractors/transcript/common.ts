import fs from 'fs';
import type { ExtractedSession, TranscriptEntry, ToolCallSummary, ContentBlock } from '../../types.js';

/** Read the last N lines of a file efficiently without loading the whole file */
export function tailFile(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  return lines.slice(-maxLines);
}

/** Parse a JSONL file, returning the last N valid JSON lines */
export function parseJsonlTail(filePath: string, maxLines: number): TranscriptEntry[] {
  const lines = tailFile(filePath, maxLines);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines — common at the end of an interrupted write
    }
  }
  return entries;
}

/** Extract plain text from a content field that may be string or ContentBlock[] */
export function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n');
}

/** Detect obvious secrets (API keys, tokens, passwords) and redact them */
export function redactSecrets(text: string): string {
  return text
    // AWS keys
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED-AWS-KEY]')
    // Generic bearer/API tokens (long alphanumeric strings after key= or token= or key:)
    .replace(/(api[_-]?key|token|secret|password|passwd|bearer)\s*[=:]\s*["']?[A-Za-z0-9\-_./+=]{16,}["']?/gi, '$1=[REDACTED]')
    // GitHub tokens
    .replace(/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED-GH-TOKEN]')
    // OpenAI keys
    .replace(/sk-[A-Za-z0-9]{32,}/g, '[REDACTED-OPENAI-KEY]')
    // Cursor keys
    .replace(/cursor_[A-Za-z0-9]{16,}/g, '[REDACTED-CURSOR-KEY]')
    // Private key blocks
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PRIVATE-KEY]');
}

/**
 * Build a partial ExtractedSession from parsed transcript entries.
 * Works for all three agents since they share the same JSONL schema shape.
 */
export function buildSessionFromEntries(
  entries: TranscriptEntry[],
  agent: ExtractedSession['agent'],
  sessionId?: string,
  transcriptPath?: string,
): ExtractedSession {
  const toolCalls: ToolCallSummary[] = [];
  let lastUserMessage: string | undefined;
  let lastAssistantSummary: string | undefined;
  const errors: string[] = [];

  for (const entry of entries) {
    if (entry.type === 'message' || entry.type === 'assistant' || entry.role === 'assistant') {
      const text = extractText(entry.content as string | ContentBlock[]);
      if (text) lastAssistantSummary = text.slice(0, 500);
    }

    if (entry.role === 'user' || entry.type === 'user') {
      const text = extractText(entry.content as string | ContentBlock[]);
      if (text && !text.startsWith('[Tool result')) {
        lastUserMessage = text.slice(0, 400);
      }
    }

    // Tool call entries (Cursor/Claude Code format)
    if (entry.type === 'tool_use' || (entry.tool && entry.tool_input)) {
      const toolName = (entry.tool ?? entry.type) as string;
      const inputStr = JSON.stringify(entry.tool_input ?? {}).slice(0, 200);
      toolCalls.push({ tool: toolName, input: inputStr });
    }

    // Tool result
    if (entry.type === 'tool_result') {
      if (toolCalls.length > 0) {
        const last = toolCalls[toolCalls.length - 1];
        last.result = JSON.stringify(entry.tool_result ?? '').slice(0, 200);
      }
    }

    // Error entries
    if (entry.type === 'error' || entry.error) {
      errors.push((entry.error ?? JSON.stringify(entry)).slice(0, 300));
    }
  }

  // Extract progress items from last assistant message (look for checkboxes)
  const progressItems = extractProgressItems(lastAssistantSummary ?? '');

  return {
    agent,
    sessionId,
    transcriptPath,
    lastUserMessage,
    lastAssistantSummary,
    recentToolCalls: toolCalls.slice(-15),
    taskDescription: lastUserMessage,
    progressItems,
    errors: errors.slice(-5),
    transcriptTail: entries.map(e => JSON.stringify(e)).join('\n'),
  };
}

function extractProgressItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^[-*]\s*\[([x ])\]\s*(.+)/i);
    if (match) {
      const done = match[1].toLowerCase() === 'x';
      items.push(`${done ? '[x]' : '[ ]'} ${match[2].trim()}`);
    }
  }
  return items;
}
