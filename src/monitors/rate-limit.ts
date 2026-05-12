/**
 * Rate limit error detection patterns for relay watch.
 * Used to detect when an agent hit a hard rate limit mid-session
 * by scanning new bytes appended to the transcript file.
 */

export const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /usage[\s_-]?limit/i,
  /quota[\s_-]?exceeded/i,
  /\b429\b/,
  /too[\s_-]?many[\s_-]?requests/i,
  /you['']ve reached your (limit|quota)/i,
  /requests? per (hour|minute|day)/i,
  /billing limit/i,
  /capacity limit/i,
  /claude\.ai\/upgrade/i,
  /upgrade your plan/i,
];

export interface RateLimitHit {
  pattern: string;
  matchedText: string;
}

export function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some(p => p.test(text));
}

export function detectRateLimitHit(texts: string[]): RateLimitHit | null {
  for (const text of texts) {
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(text)) {
        return { pattern: pattern.toString(), matchedText: text.slice(0, 200) };
      }
    }
  }
  return null;
}
