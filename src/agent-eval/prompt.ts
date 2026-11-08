/**
 * Prompt templates (version-stamped; frozen in experiments/02-agent-diagnosis/FROZEN.json before any test run).
 * Agentic: the SAME text for every condition; only the attached tools differ.
 * Single-shot: the same text for every retrieval method; only the injected context differs.
 */
import type { Diagnosis } from './types.js';

export const PROMPT_VERSION = 'p1';

export const AGENT_SYSTEM_PROMPT = [
  'You are a senior software engineer diagnosing a bug in the codebase in your current working directory.',
  'You can read and search files but you cannot run code, run tests, use git, or modify files.',
  'Investigate until you are confident, then give your diagnosis. Be efficient: do not read files you do not need.',
].join(' ');

export const SINGLE_SHOT_SYSTEM_PROMPT = 'You are a senior software engineer diagnosing a bug from a bug report and the material provided. Answer with JSON only.';

export function agentTaskPrompt(bugReport: string): string {
  return [
    'A user filed the following bug report against this NestJS/TypeScript backend:',
    '',
    '<bug_report>',
    bugReport,
    '</bug_report>',
    '',
    'Find the code that causes this behaviour. Use the available tools to investigate.',
    'Then return your diagnosis: up to 3 candidate locations, most likely first. For each candidate give the',
    'repository-relative file path, the function or method containing the defect (ClassName.methodName or functionName),',
    'the line range of the defective code, and a short explanation of how it causes the reported behaviour.',
    'Optionally describe the fix.',
  ].join('\n');
}

export function singleShotPrompt(bugReport: string, context: string, kind: 'retrieved' | 'file-list' | 'oracle'): string {
  const intro = kind === 'file-list'
    ? 'Below is a bug report for a NestJS/TypeScript backend, followed by the list of files in the repository. You cannot see any file contents.'
    : 'Below is a bug report for a NestJS/TypeScript backend, followed by code snippets retrieved from the repository by a code-search tool. The defective code may or may not be among the snippets.';
  return [
    intro,
    '',
    '<bug_report>',
    bugReport,
    '</bug_report>',
    '',
    kind === 'file-list' ? '<files>' : '<retrieved_code>',
    context || '(no results)',
    kind === 'file-list' ? '</files>' : '</retrieved_code>',
    '',
    'Identify the code that causes this behaviour. Return your diagnosis: up to 3 candidate locations, most likely first.',
    'For each candidate give the repository-relative file path, the function or method containing the defect',
    '(ClassName.methodName or functionName), the line range of the defective code, and a short explanation.',
    'Optionally describe the fix. Respond with JSON only, matching:',
    '{"candidates":[{"file":"...","symbol":"...","start_line":0,"end_line":0,"explanation":"..."}],"fix":{"file":"...","description":"..."}}',
  ].join('\n');
}

/** Oracle context (upper bound for single-shot): the ground-truth relevant symbols rendered from the snapshot, shuffled deterministically. */
export function oracleContext(snippets: { key: string; text: string }[]): string {
  return [...snippets].sort((a, b) => (hash(a.key) - hash(b.key))).map((s) => s.text).join('\n');
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function describeDiagnosis(d: Diagnosis | null): string {
  if (!d) return '(none)';
  return d.candidates.map((c, i) => `${i + 1}. ${c.file}:${c.start_line ?? '?'}-${c.end_line ?? '?'} ${c.symbol}`).join(' | ');
}
