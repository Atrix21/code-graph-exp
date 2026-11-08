/**
 * Independent audit of src/agent-eval/scoring.ts (experiment 2). Written by the auditor, not the harness author.
 *
 * Convention: `it(...)` documents behaviour that is correct or an accepted design choice; `it.fails(...)` documents a
 * DEFECT (the test asserts the behaviour we want, and passes only while the defect exists; flip it to `it` once fixed).
 * See experiments/02-agent-diagnosis/AUDIT.md for the finding ids (F-xx).
 */
import { describe, expect, it } from 'vitest';
import { abs, loadConfig } from '../../src/config.js';
import { loadTasks } from '../../src/evaluation/ground-truth.js';
import { SymbolIndex } from '../../src/evaluation/symbol-index.js';
import { bugLocations, scoreDiagnosis, snapshotIndex } from '../../src/agent-eval/scoring.js';

const cfg = loadConfig();
const tasks = loadTasks(abs(cfg.dataset.tasks_dir));
const byId = (id: string) => tasks.find((t) => t.task_id === id)!;

function setup(taskId: string) {
  const t = byId(taskId);
  const index = snapshotIndex(cfg, taskId, 'test-audit-scoring'); // read-only export (parallel-safe)
  const bugs = bugLocations(cfg, taskId);
  const [file, sym] = t.root_cause_symbols[0].split('::');
  const line = bugs.find((b) => b.file === file)!.lines[0];
  const decl = index.byKey.get(t.root_cause_symbols[0])!;
  const score = (cand: Record<string, unknown>) => scoreDiagnosis(index, t, bugs, { candidates: [{ explanation: '', ...cand } as any] });
  return { t, index, bugs, file, sym, line, decl, score };
}

describe('AUDIT scoring: agent-style answers, all 20 tasks', () => {
  for (const t of tasks) {
    it(`${t.task_id}: ./ prefix, trailing "()", last-segment-only, whole-symbol range and whole-file range all score 1`, () => {
      const s = setup(t.task_id);
      expect(s.score({ file: './' + s.file, symbol: s.sym, start_line: s.line, end_line: s.line }).rc_line_at_1).toBe(1);
      expect(s.score({ file: s.file, symbol: s.sym + '()', start_line: s.line, end_line: s.line }).rc_line_at_1).toBe(1);
      expect(s.score({ file: s.file, symbol: s.sym.split('.').pop(), start_line: s.line, end_line: s.line }).rc_line_at_1).toBe(1);
      expect(s.score({ file: s.file, symbol: s.sym, start_line: s.decl.start_line, end_line: s.decl.end_line }).rc_line_at_1).toBe(1);
      // F-12 fixed: a range far wider than the defective declaration (here the whole file) earns no line credit
      const fileLen = s.index.fileLines.get(s.file)!.length;
      if (fileLen > s.decl.end_line - s.decl.start_line + 1 + 10) expect(s.score({ file: s.file, symbol: s.sym, start_line: 1, end_line: fileLen }).rc_line_at_1).toBe(0);
    });

    // F-02 (blocker): Claude Code's Read/Grep/Glob tools take and print ABSOLUTE paths, and CRG's tool output is absolute.
    // The scorer resolves absolute paths against the SCORING workspace (a different opaque dir), so every such answer is 0.
    it(`${t.task_id}: a correct answer given as an absolute path inside the agent's workspace is scored correct (F-02)`, () => {
      const s = setup(t.task_id);
      const r = s.score({ file: `/tmp/work/0123456789/app/${s.file}`, symbol: s.sym, start_line: s.line, end_line: s.line });
      expect(r.rc_line_at_1).toBe(1);
      expect(r.file_at_1).toBe(1);
    });
  }

  it('a correct answer written as "path:line" in the file field is scored correct (F-02, same normaliser fix)', () => {
    const s = setup('users_list_page_01');
    expect(s.score({ file: `${s.file}:${s.line}`, symbol: s.sym, start_line: s.line, end_line: s.line }).rc_line_at_1).toBe(1);
  });

  it('a correct symbol with a trailing prose annotation and no line numbers still resolves the symbol (F-13)', () => {
    const s = setup('users_list_page_01');
    // normaliseName() strips "(...)" but leaves the space before it, so exact and suffix lookups both miss
    expect(s.score({ file: s.file, symbol: `${s.sym} (page offset)` }).rc_at_1).toBe(1);
  });
});

describe('AUDIT scoring: the special tasks named in the brief', () => {
  it('auth_reset_sessions_01 (pure deletion): the defect point is the line AFTER the removed block; slack is +-2 lines', () => {
    const s = setup('auth_reset_sessions_01');
    expect(s.bugs).toEqual([{ file: 'src/auth/auth.service.ts', lines: [415] }]);
    const hit = (l: number) => s.score({ file: s.file, symbol: s.sym, start_line: l, end_line: l }).rc_line_at_1;
    expect([412, 413, 414, 415, 416, 417, 418].map(hit)).toEqual([0, 1, 1, 1, 1, 1, 0]);
    // the realistic "the delete-sessions call is missing before update()" answer: range around the update call
    expect(s.score({ file: s.file, symbol: 'AuthService.resetPassword', start_line: 410, end_line: 416 }).rc_line_at_1).toBe(1);
  });

  it('files_photo_url_01 (decorator callback on a property): FileType.path resolves; the class name alone does not (RC=0, line=1)', () => {
    const s = setup('files_photo_url_01');
    expect(s.decl.kind).toBe('property');
    expect(s.score({ file: s.file, symbol: 'FileType.path', start_line: 27, end_line: 27 }).rc_line_at_1).toBe(1);
    expect(s.score({ file: s.file, symbol: 'path', start_line: 27, end_line: 27 }).rc_line_at_1).toBe(1);
    const cls = s.score({ file: s.file, symbol: 'FileType', start_line: 27, end_line: 27 });
    expect([cls.rc_at_1, cls.line_at_1, cls.rc_line_at_1, cls.file_at_1]).toEqual([0, 1, 0, 1]);
    // a free-text symbol with correct lines is rescued by the line-overlap fallback of the normaliser
    expect(s.score({ file: s.file, symbol: 'FileType.path @Transform callback', start_line: 26, end_line: 28 }).rc_line_at_1).toBe(1);
  });

  it('roles_admin_guard_01 (class-level guard): RolesGuard.canActivate scores 1; answering with the class RolesGuard scores RC=0 (strict, shared with exp. 1)', () => {
    const s = setup('roles_admin_guard_01');
    expect(s.score({ file: s.file, symbol: 'RolesGuard.canActivate', start_line: 21, end_line: 21 }).rc_line_at_1).toBe(1);
    const cls = s.score({ file: s.file, symbol: 'RolesGuard', start_line: 21, end_line: 21 });
    expect([cls.rc_at_1, cls.line_at_1, cls.file_at_1]).toEqual([0, 1, 1]);
  });

  it('multi-line patches (auth_jwt_secret_01 lines 14-16, users_update_noop_01 lines 114-115): any bug line within slack counts', () => {
    const j = setup('auth_jwt_secret_01');
    expect(j.bugs[0].lines).toEqual([14, 14, 15, 16]);
    expect(j.score({ file: j.file, symbol: 'JwtStrategy.constructor', start_line: 18, end_line: 18 }).rc_line_at_1).toBe(1); // 16 + 2
    expect(j.score({ file: j.file, symbol: 'JwtStrategy.constructor', start_line: 19, end_line: 19 }).rc_line_at_1).toBe(0);
    const u = setup('users_update_noop_01');
    expect(u.bugs[0].lines).toEqual([114, 115]);
    expect(u.score({ file: u.file, symbol: 'UsersRelationalRepository.update', start_line: 117, end_line: 117 }).rc_line_at_1).toBe(1);
  });

  it('relational/document twins are separated by FILE: the right class name in the wrong twin file is a miss; a missing start_line loses the primary metric (F-14)', () => {
    const s = setup('users_mapper_lastname_01');
    const twin = s.file.replace('/relational/', '/document/');
    expect(s.index.byFile.has(twin)).toBe(true); // the document twin exists and has a same-named class
    expect(s.score({ file: twin, symbol: 'UserMapper.toPersistence', start_line: 63, end_line: 63 }).rc_at_1).toBe(0);
    // lines are now required in DIAGNOSIS_SCHEMA (F-14); a diagnosis without them still loses the primary metric
    const noLines = s.score({ file: s.file, symbol: s.sym });
    expect([noLines.rc_at_1, noLines.rc_line_at_1]).toEqual([1, 0]);
  });
});
