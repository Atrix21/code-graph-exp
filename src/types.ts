/**
 * Common interfaces shared by every retrieval method and by the evaluation harness.
 *
 * Retrieval methods only ever receive a RetrievalQuery (task id + natural-language
 * bug report). They never see ground-truth labels.
 */

export interface RetrievalQuery {
  task_id: string;
  /** Natural-language bug report, exactly as given to every method. */
  query: string;
}

/** Same budget object is passed to every method for a given run. */
export interface RetrievalBudget {
  /** Maximum number of ranked results returned (metrics use top-k <= this). */
  maxResults: number;
  /** Maximum size of the native context text, in proxy tokens (see token-accounting.ts). */
  maxContextTokens: number;
}

export interface RetrievedItem {
  /** Repo-relative POSIX path. */
  file: string;
  /** Symbol name as reported by the method (may be qualified, unqualified, or null). */
  symbol: string | null;
  start_line: number | null;
  end_line: number | null;
  score: number | null;
  node_type?: string | null;
  /** Method-specific identifier (graph node id, chunk id, ...). */
  raw_id?: string;
  /** Optional provenance (edge paths, matched terms, ...). Not used for scoring. */
  evidence?: unknown;
}

export interface LlmTokenUsage {
  input: number;
  output: number;
}

export interface RetrievalOutput {
  task_id: string;
  method: string;
  /** Ranked results, best first. */
  results: RetrievedItem[];
  /** The exact text the method hands to an agent (its native context). */
  context: string;
  latency_ms: number;
  /** Retrieval-time LLM tokens. 0/0 for non-LLM methods; null when unmeasurable. */
  llm_tokens: LlmTokenUsage | null;
  metadata?: Record<string, unknown>;
}

export interface IndexStats {
  method: string;
  index_ms: number;
  /** LLM tokens spent at index time (null = unknown/unmeasurable, 0 = none used). */
  index_llm_tokens: number | null;
  /** Tokens passed through the embedding model at index time (null if not applicable). */
  embedding_tokens: number | null;
  details?: Record<string, unknown>;
}

export interface Corpus {
  /** Absolute path of the target repository checkout. */
  repoRoot: string;
  /** Commit hash of the benchmark revision. */
  commit: string;
  /** Eligible repo-relative POSIX file paths (identical for all methods). */
  files: string[];
  /** Directory where methods may store index artefacts. */
  cacheDir: string;
}

export interface RetrievalMethod {
  readonly name: string;
  prepare(corpus: Corpus): Promise<IndexStats>;
  retrieve(q: RetrievalQuery, budget: RetrievalBudget): Promise<RetrievalOutput>;
  /** Optional batch path (used by out-of-process competitors to avoid start-up cost per query). */
  retrieveBatch?(qs: RetrievalQuery[], budget: RetrievalBudget): Promise<RetrievalOutput[]>;
  close?(): Promise<void>;
}

/* ----------------------------- Ground truth ----------------------------- */

/** Canonical symbol key: "<repo-relative file>::<QualifiedName>", e.g. "src/auth/auth.service.ts::AuthService.refreshToken". */
export type SymbolKey = string;

export interface GroundTruthTask {
  task_id: string;
  split: 'dev' | 'test';
  /** The bug report handed to retrieval methods. */
  description: string;
  /** Symbols where the defect lives (fix location). */
  root_cause_symbols: SymbolKey[];
  /** Root cause + symbols an engineer must read to understand/confirm the bug (includes root cause). */
  relevant_symbols: SymbolKey[];
  relevant_files: string[];
  expected_relationships?: [string, string, string][];
  data_flow?: string[];
  control_flow_conditions?: { symbol: SymbolKey; condition: string; line?: number }[];
  distractor_symbols?: SymbolKey[];
  difficulty?: 'easy' | 'medium' | 'hard';
  lexical_overlap?: 'high' | 'medium' | 'low';
  bug_category?: string;
  notes?: string;
}
