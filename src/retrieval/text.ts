/**
 * Shared, deterministic text processing for all lexical components (BM25, ripgrep
 * keyword extraction, graph seeding). One tokenizer for every lexical method.
 */
import { stemmer } from 'stemmer';

export const ENGLISH_STOPWORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does doing done for from had has have having he her his how i if in into is it its ' +
    'just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then ' +
    'there these they this those through to too under until up very was we were what when where which while who whom why will with would you your ' +
    'also after again against all am any because before below between both down during each few further here itself let ' +
    'ours ourselves themselves yourself yourselves myself himself herself shall may might must us one two get got gets getting even still ' +
    'seems seem seemed instead though although however sometimes occasionally always never every someone something anyone anything ' +
    'see saw seen look looks looked reported report reports noticed notice issue issues bug bugs problem problems happen happens happened ' +
    'expected expect actually really already yet ever without within across via etc'
  ).split(/\s+/),
);

/** TypeScript/JS keywords and ubiquitous code tokens that carry no topical signal. */
export const CODE_STOPWORDS = new Set(
  (
    'const let var function return async await this new class extends implements interface type import export from default ' +
    'public private protected readonly static void null undefined true false string number boolean any unknown never ' +
    'if else for while do switch case break continue try catch finally throw typeof instanceof in of as is ' +
    'promise ts js'
  ).split(/\s+/),
);

/** Split identifiers on camelCase / PascalCase / snake_case / kebab-case / digits. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$]+/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

export interface TokenizeOptions {
  stem?: boolean;
  removeStopwords?: boolean;
  /** Also emit the full lowercased identifier (e.g. "refreshtoken") in addition to its parts. */
  keepCompound?: boolean;
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const { stem = true, removeStopwords = true, keepCompound = true } = opts;
  const out: string[] = [];
  const raw = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? [];
  for (const w of raw) {
    const parts = splitIdentifier(w);
    const emit = (t: string) => {
      const lw = t.toLowerCase();
      if (lw.length < 2) return;
      if (removeStopwords && (ENGLISH_STOPWORDS.has(lw) || CODE_STOPWORDS.has(lw))) return;
      out.push(stem ? stemmer(lw) : lw);
    };
    for (const p of parts) emit(p);
    if (keepCompound && parts.length > 1) emit(w.replace(/[_\-$]/g, ''));
  }
  return out;
}

/** Identifier-like tokens in a natural-language report (camelCase, snake_case, dotted, quoted, CONSTANTS, paths). */
export function extractIdentifierLikeTerms(text: string): string[] {
  const set = new Set<string>();
  const re = /[`'"]([^`'"\n]{2,60})[`'"]|\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\b|\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+|[A-Z]{2,}[A-Z0-9_]*)\b|(\/[a-z0-9\-_/:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (t.length >= 3) set.add(t);
  }
  return [...set];
}
