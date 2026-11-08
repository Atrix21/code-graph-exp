/**
 * Experiment 2: downstream agent bug diagnosis. Shared types.
 *
 * Two protocols:
 *  - "agentic": a coding agent (Claude Code headless, or the mock/local validation backends) explores an isolated
 *    workspace with read-only file tools (+ one retrieval MCP server, depending on the condition) and submits a diagnosis.
 *  - "single_shot": the model receives the bug report plus one retrieval method's native context (no tools) and submits
 *    a diagnosis. Isolates the value of the retrieved context itself.
 */

export type Protocol = 'agentic' | 'single_shot';

/** A condition = what the agent gets besides the bug report. */
export interface Condition {
  id: string; // e.g. "agentic:baseline", "agentic:hybrid", "single:embeddings@4k"
  protocol: Protocol;
  /** Retrieval provider: 'none' (file tools only / no context), one of our RetrievalMethod names, 'graphify-mcp', 'crg-mcp', or 'oracle'. */
  retrieval: string;
  /** Token budget per retrieval call (agentic) or for the injected context (single_shot). */
  contextBudget: number;
  description: string;
}

export interface DiagnosisCandidate {
  file: string; // repo-relative path
  symbol: string; // e.g. "AuthService.refreshToken"
  start_line?: number;
  end_line?: number;
  explanation: string;
}

/** What every backend must return (validated against DIAGNOSIS_SCHEMA). */
export interface Diagnosis {
  candidates: DiagnosisCandidate[]; // ranked, most likely first, 1..3
  fix?: { file: string; description: string; replacement_code?: string };
}

export interface TokenUsage {
  input: number; // uncached input tokens
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface AgentRun {
  run_id: string;
  task_id: string;
  condition: string;
  backend: string; // 'claude-code' | 'mock' | 'local-qwen'
  model: string;
  repeat: number;
  diagnosis: Diagnosis | null;
  parse_error?: string;
  usage: TokenUsage | null; // null = unavailable (never invented)
  usage_source: 'api-reported' | 'proxy-tokenizer' | 'unavailable';
  cost_usd: number | null; // as reported by the backend; null if unavailable
  latency_ms: number;
  turns: number | null;
  tool_calls: Record<string, number>; // tool name -> count
  retrieval_calls: number;
  stop_reason: string; // 'submitted' | 'max_turns' | 'budget' | 'error' | 'timeout'
  transcript_path?: string;
  workspace_hash: string; // proves which snapshot the agent saw
}

export const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', minItems: 1, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'symbol', 'explanation'],
        properties: {
          file: { type: 'string', description: 'Repository-relative path of the file containing the defect' },
          symbol: { type: 'string', description: 'Function/method containing the defect, e.g. ClassName.methodName or functionName' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          explanation: { type: 'string', description: 'Why this code causes the reported behaviour' },
        },
      },
    },
    fix: {
      type: 'object', additionalProperties: false, required: ['file', 'description'],
      properties: { file: { type: 'string' }, description: { type: 'string' }, replacement_code: { type: 'string' } },
    },
  },
} as const;
