import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loadTasks } from '../../src/evaluation/ground-truth.js';
import { abs } from '../../src/config.js';
import { checkoutSnapshot } from '../../src/evaluation/corpus.js';
import { SymbolIndex } from '../../src/evaluation/symbol-index.js';
import { bugLocations, parseDiagnosis, scoreDiagnosis } from '../../src/agent-eval/scoring.js';

const cfg = loadConfig();
const tasks = loadTasks(abs(cfg.dataset.tasks_dir));

describe('diagnosis scorer on every task', () => {
  for (const t of tasks) {
    it(`${t.task_id}: perfect=1, right-symbol-wrong-line partial, wrong=0`, () => {
      const corpus = checkoutSnapshot(cfg, t.task_id);
      const index = new SymbolIndex(corpus.repoRoot, corpus.files);
      const bugs = bugLocations(cfg, t.task_id);
      const [file, sym] = t.root_cause_symbols[0].split('::');
      const line = bugs.find((b) => b.file === file)!.lines[0];
      const perfect = scoreDiagnosis(index, t, bugs, { candidates: [{ file, symbol: sym, start_line: line, end_line: line, explanation: '' }] });
      expect(perfect.rc_line_at_1).toBe(1);
      expect(perfect.rc_rank).toBe(1);
      const decl = index.byKey.get(t.root_cause_symbols[0])!;
      const far = decl.end_line - line > 4 ? decl.end_line : decl.start_line; // inside the symbol but away from the defect when possible
      const partial = scoreDiagnosis(index, t, bugs, { candidates: [{ file, symbol: sym, start_line: far, end_line: far, explanation: '' }] });
      expect(partial.rc_at_1).toBe(1);
      if (Math.abs(far - line) > 2) expect(partial.line_at_1).toBe(0);
      const wrong = scoreDiagnosis(index, t, bugs, { candidates: [{ file: 'src/app.module.ts', symbol: 'AppModule', start_line: 1, end_line: 1, explanation: '' }] });
      expect(wrong.rc_at_3).toBe(0);
      expect(wrong.line_at_3).toBe(0);
      const second = scoreDiagnosis(index, t, bugs, { candidates: [{ file: 'src/app.module.ts', symbol: 'AppModule', explanation: '' }, { file, symbol: sym, start_line: line, end_line: line, explanation: '' }] });
      expect(second.rc_at_1).toBe(0);
      expect(second.rc_at_3).toBe(1);
      expect(second.rc_rank).toBe(2);
    });
  }
  it('parses fenced JSON and rejects junk', () => {
    expect(parseDiagnosis('```json\n{"candidates":[{"file":"a.ts","symbol":"f","explanation":"x"}]}\n```').diagnosis?.candidates[0].symbol).toBe('f');
    expect(parseDiagnosis('I think it is in auth').diagnosis).toBeNull();
    expect(parseDiagnosis({ candidates: [] }).diagnosis).toBeNull();
  });
});
