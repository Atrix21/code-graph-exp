/**
 * Token accounting.
 *
 * No Anthropic API key is available in this environment, so we cannot call the
 * count_tokens endpoint. We use OpenAI's o200k_base BPE (js-tiktoken) as a
 * *proxy* tokenizer, applied identically to every method's output. Absolute
 * numbers are therefore proxy tokens; relative comparisons between methods are
 * what matters. See research/methodology.md.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken';

export const TOKENIZER_ID = 'o200k_base (js-tiktoken 1.0.21) — proxy for Claude tokens';

let enc: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (!enc) enc = getEncoding('o200k_base');
  return enc;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder().encode(text).length;
}

/** Truncate text to at most maxTokens proxy tokens (cuts on a line boundary when possible). */
export function truncateToTokens(text: string, maxTokens: number): { text: string; tokens: number; truncated: boolean } {
  const total = countTokens(text);
  if (total <= maxTokens) return { text, tokens: total, truncated: false };
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = countTokens(line + '\n');
    if (used + t > maxTokens) break;
    out.push(line);
    used += t;
  }
  const s = out.join('\n');
  return { text: s, tokens: countTokens(s), truncated: true };
}
