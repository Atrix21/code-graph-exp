/**
 * Graph schema for our custom TypeScript code graph.
 * Every node has a stable ID derived only from source (deterministic across runs on unchanged source).
 * Every edge carries provenance: evidence location, extraction method, confidence, verification status.
 */

export const NODE_TYPES = [
  'repository', 'file', 'module', 'class', 'function', 'method', 'interface', 'type', 'variable',
  'parameter', 'property', 'import', 'export', 'condition', 'branch', 'exception_handler', 'loop', 'return',
  'external_dependency', 'route', 'db_entity', 'event',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_FAMILIES = {
  structural: ['CONTAINS', 'IMPORTS', 'EXPORTS', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'REFERENCES', 'DEFINES', 'HAS_TYPE'],
  execution: ['CALLS', 'RETURNS', 'THROWS', 'CATCHES', 'BRANCHES_TO', 'CHECKS', 'RECURSES_TO', 'LOOPS'],
  data_flow: ['READS', 'WRITES', 'PASSES_TO', 'RECEIVES_FROM', 'MUTATES', 'RETURNS_VALUE_TO'],
  application: [
    'ROUTES_TO', 'CONTROLLER_CALLS', 'SERVICE_USES', 'REPOSITORY_ACCESSES', 'QUERIES_DATABASE',
    'PUBLISHES_EVENT', 'CONSUMES_EVENT', 'INJECTS_DEPENDENCY', 'CALLS_EXTERNAL_API',
  ],
} as const;
export type EdgeFamily = keyof typeof EDGE_FAMILIES;
export type EdgeType = (typeof EDGE_FAMILIES)[EdgeFamily][number];

/** Control-flow edges are a subset of the execution family (used by ablations). */
export const CONTROL_FLOW_EDGES: EdgeType[] = ['BRANCHES_TO', 'CHECKS', 'RETURNS', 'THROWS', 'CATCHES', 'LOOPS'];

export function edgeFamily(t: EdgeType): EdgeFamily {
  for (const [fam, types] of Object.entries(EDGE_FAMILIES)) if ((types as readonly string[]).includes(t)) return fam as EdgeFamily;
  throw new Error(`unknown edge type ${t}`);
}

/**
 * Verification status (never present an inferred relationship as verified):
 *  - static_verified:    resolved by the TypeScript type checker / syntax with no guesswork
 *  - framework_inferred: derived from framework conventions (e.g. NestJS decorators, DI, TypeORM repos)
 *  - semantic_inferred:  derived from naming/heuristics (e.g. property-name matching, string event names)
 *  - ambiguous:          multiple candidate targets; edge points to one candidate (or a placeholder)
 *  - unknown:            detected but unresolved (target is an 'unresolved' placeholder node)
 */
export type Verification = 'static_verified' | 'framework_inferred' | 'semantic_inferred' | 'ambiguous' | 'unknown';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  /** Qualified name within file, e.g. AuthService.refreshToken (for declarations). */
  qualified_name: string | null;
  file: string | null; // repo-relative posix
  start_line: number | null;
  end_line: number | null;
  start_col: number | null;
  end_col: number | null;
  /** Free-form metadata: signature, modifiers, decorators, condition text, route path/method, etc. */
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  src: string;
  dst: string;
  /** Evidence location (where in source the relationship is witnessed). */
  file: string | null;
  line: number | null;
  col: number | null;
  /** e.g. 'ts-checker', 'ts-syntax', 'nestjs-decorator', 'nestjs-di', 'typeorm-repository', 'name-heuristic' */
  extraction: string;
  confidence: number; // 0..1
  verification: Verification;
  /** Short evidence text (the call expression / condition source text, truncated). */
  evidence: string | null;
  meta: Record<string, unknown>;
}

export interface GraphStats {
  nodes_by_type: Record<string, number>;
  edges_by_type: Record<string, number>;
  edges_by_verification: Record<string, number>;
}

export interface CoverageReport {
  eligible_files: number;
  parsed_files: number;
  parse_failures: { file: string; error: string }[];
  declared_functions: number; // functions + methods + ctors + accessors + fn-valued props/vars (syntactic count)
  extracted_functions: number;
  detected_calls: number; // CallExpression + NewExpression sites inside project code
  resolved_calls_internal: number; // resolved to a project declaration
  resolved_calls_external: number; // resolved to an external/library declaration
  unresolved_calls: number;
  detected_imports: number;
  resolved_imports: number;
  unresolved_imports: string[];
  unresolved_references: number;
  unsupported_syntax: Record<string, number>;
  notes: string[];
}
