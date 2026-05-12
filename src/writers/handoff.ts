import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { HandoffDocument } from '../types.js';
import { redactSecrets } from '../extractors/transcript/common.js';
import { getHandoffDir, ensureRelayDirs } from '../config.js';

const REASON_LABEL: Record<HandoffDocument['reason'], string> = {
  context_window: 'Context window limit reached',
  rate_limit:     'Subscription/rate limit reached',
  emergency:      'Emergency: agent stopped unexpectedly',
  manual:         'Manual transfer',
};

/** Write a handoff document and return its file path */
export function writeHandoff(doc: HandoffDocument, cwd: string): string {
  ensureRelayDirs(cwd);
  const dir = getHandoffDir(cwd);
  const filename = `HANDOFF-${doc.id}.md`;
  const filePath = path.join(dir, filename);

  const content = renderHandoff(doc);
  fs.writeFileSync(filePath, redactSecrets(content), 'utf8');

  // Also write a HANDOFF-latest.md symlink / copy so agents can always find it
  const latestPath = path.join(dir, 'HANDOFF-latest.md');
  fs.writeFileSync(latestPath, redactSecrets(content), 'utf8');

  return filePath;
}

function renderHandoff(doc: HandoffDocument): string {
  const isEmergency = doc.reason === 'emergency';
  const progressSection = doc.progressItems.length
    ? doc.progressItems.map(p => `- ${p}`).join('\n')
    : '- (no structured progress items found — review last assistant message above)';

  const decisionsSection = doc.keyDecisions.length
    ? doc.keyDecisions.map(d => `- ${d}`).join('\n')
    : '- (none recorded)';

  const errorsSection = doc.errors.length
    ? doc.errors.map(e => `- \`${e}\``).join('\n')
    : '- none';

  const modifiedSection = [
    ...doc.git.modifiedFiles.map(f => `- \`${f}\` (modified)`),
    ...doc.git.untrackedFiles.map(f => `- \`${f}\` (untracked/new)`),
  ].join('\n') || '- (no uncommitted changes)';

  const toolCallsSection = doc.session.recentToolCalls.length
    ? doc.session.recentToolCalls
        .map(tc => `- **${tc.tool}**: \`${tc.input}\`${tc.failed ? ' ❌ FAILED' : ''}`)
        .join('\n')
    : '- (none)';

  const diffSection = doc.git.diff
    ? `\`\`\`diff\n${doc.git.diff}\n\`\`\``
    : '(no uncommitted diff)';

  const warningBanner = isEmergency
    ? `> ⚠️ **EMERGENCY HANDOFF** — the previous agent stopped unexpectedly mid-task.\n> The progress below is reconstructed from the transcript tail + git state.\n> Run \`git diff HEAD\` for the complete picture of what changed.\n\n`
    : '';

  return `# Relay Handoff: ${doc.taskDescription ?? 'Untitled Task'}
${warningBanner}
## Metadata

| Field | Value |
|-------|-------|
| Handoff ID | \`${doc.id}\` |
| Timestamp | ${doc.timestamp} |
| From Agent | **${doc.fromAgent}** |
| Reason | ${REASON_LABEL[doc.reason]}${doc.contextPercent ? ` (${doc.contextPercent}% used)` : ''} |
| Git Branch | \`${doc.git.branch}\` |
| Uncommitted Changes | ${doc.git.hasUncommittedChanges ? 'Yes' : 'No'} |

## Task Description

${doc.taskDescription ?? '(not captured — see last user message below)'}

## Progress

${progressSection}

## Key Decisions Made

${decisionsSection}

## Modified Files (uncommitted)

${modifiedSection}

## Current State

${doc.currentState || doc.session.lastAssistantSummary || '(not captured)'}

## Last User Message

${doc.session.lastUserMessage ?? '(not captured)'}

## Recent Tool Calls

${toolCallsSection}

## Errors / Blockers

${errorsSection}

## Git Status

\`\`\`
${doc.git.status || '(clean)'}
\`\`\`

## Git Diff Stat

\`\`\`
${doc.git.diffStat || '(no changes)'}
\`\`\`

## Recent Commits

\`\`\`
${doc.git.recentCommits || '(none)'}
\`\`\`

## Uncommitted Diff

${diffSection}

---

## Instructions for the Next Agent

You are picking up a task that was started by **${doc.fromAgent}** and could not be completed due to: _${REASON_LABEL[doc.reason]}_.

**Do the following:**

1. Read this entire document carefully.
2. Run \`git status\` and \`git diff HEAD\` to see the current state of the codebase.
3. Review the "Modified Files" and "Uncommitted Diff" sections — these show exactly what has been done so far.
4. Continue from where the previous agent left off. Focus on the unchecked items in the **Progress** section.
5. Do NOT redo work that is already done. The uncommitted changes are real and in the working tree.
6. If anything is unclear, check the **Recent Tool Calls** section for what the previous agent was doing last.

Acknowledge this handoff by stating: what you understand the remaining task to be, and what you will do first.
`;
}

/** Generate a new handoff ID (short, timestamp-based) */
export function newHandoffId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${ts}-${rand}`;
}

/** Build a HandoffDocument from structured inputs, with sensible defaults */
export function buildHandoffDoc(
  partial: Partial<HandoffDocument> & Pick<HandoffDocument, 'fromAgent' | 'reason' | 'git' | 'session'>,
): HandoffDocument {
  const id = partial.id ?? newHandoffId();
  return {
    id,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    fromAgent: partial.fromAgent,
    reason: partial.reason,
    contextPercent: partial.contextPercent,
    git: partial.git,
    session: partial.session,
    taskDescription: partial.taskDescription ?? partial.session.lastUserMessage ?? 'Unknown task',
    progressItems: partial.progressItems ?? partial.session.progressItems ?? [],
    keyDecisions: partial.keyDecisions ?? [],
    modifiedFiles: partial.modifiedFiles ?? [
      ...partial.git.modifiedFiles,
      ...partial.git.untrackedFiles,
    ],
    currentState: partial.currentState ?? partial.session.lastAssistantSummary ?? '',
    errors: partial.errors ?? partial.session.errors ?? [],
  };
}
