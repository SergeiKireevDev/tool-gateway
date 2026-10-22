import { isRecord } from '../tools/json.js';

/**
 * A small subset of jq, to pick values out of a webhook payload (e.g. the key of a conversation:
 * `.data.issue.id`, `[.repository.full_name, .issue.number]`). Deterministic and bounded: no
 * regular expressions, no recursion, no definitions; an expression yields at most `MAX_OUTPUTS`
 * values.
 *
 * - Paths: `.`, `.a.b`, `."a key"`, `.["a key"]`, `.[0]`, `.[-1]`, `.[]`, `?` (ignore errors).
 * - Literals: strings, numbers, `true`, `false`, `null`; arrays `[…]`, objects `{a: .x, b}`.
 * - Operators: `|`, `,`, `//` (alternative), `or`, `and`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`.
 * - Functions: `select(f)`, `map(f)`, `first`, `last`, `first(f)`, `length`, `keys`, `has(k)`,
 *   `type`, `not`, `empty`, `tostring`, `tojson`, `ascii_downcase`, `ascii_upcase`, `join(s)`,
 *   `split(s)`, `ltrimstr(s)`, `rtrimstr(s)`, `startswith(s)`, `endswith(s)`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const MAX_QUERY_LENGTH = 500;
const MAX_OUTPUTS = 1000;
const MAX_DEPTH = 32;

export class QueryError extends Error {}

// ---------------------------------------------------------------- tokens

type Token =
  | { t: 'punct'; v: string }
  | { t: 'field'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'string'; v: string }
  | { t: 'number'; v: number }
  | { t: 'end' };

/** Longest first, so `//` wins over `/` and `<=` over `<`. */
const PUNCTS = ['//', '==', '!=', '<=', '>=', '.', '[', ']', '{', '}', '(', ')', '|', ','];
const PUNCTS_1 = [':', ';', '?', '<', '>', '+', '-'];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_RE = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const STRING_RE = /^"(?:[^"\\]|\\.)*"/;
const SPACE_RE = /^\s+/;

function readString(src: string): { token: Token; length: number } {
  const match = STRING_RE.exec(src);
  if (!match) throw new QueryError('Unterminated string');
  try {
    return { token: { t: 'string', v: JSON.parse(match[0]) as string }, length: match[0].length };
  } catch {
    throw new QueryError(`Invalid string ${match[0]}`);
  }
}

function readToken(src: string): { token: Token; length: number } {
  if (src.startsWith('"')) return readString(src);
  const field = src.startsWith('.') ? IDENT_RE.exec(src.slice(1)) : null;
  if (field) return { token: { t: 'field', v: field[0] }, length: field[0].length + 1 };
  const ident = IDENT_RE.exec(src);
  if (ident) return { token: { t: 'ident', v: ident[0] }, length: ident[0].length };
  const num = NUMBER_RE.exec(src);
  if (num) return { token: { t: 'number', v: Number(num[0]) }, length: num[0].length };
  const punct = [...PUNCTS, ...PUNCTS_1].find((p) => src.startsWith(p));
  if (punct) return { token: { t: 'punct', v: punct }, length: punct.length };
  throw new QueryError(`Unexpected character "${src.charAt(0)}"`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let rest = src;
  while (rest.length > 0) {
    const space = SPACE_RE.exec(rest);
    if (space) {
      rest = rest.slice(space[0].length);
      continue;
    }
    const { token, length } = readToken(rest);
    tokens.push(token);
    rest = rest.slice(length);
  }
  tokens.push({ t: 'end' });
  return tokens;
}

// ---------------------------------------------------------------- syntax tree

type BinaryOp = 'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+';
const COMPARISONS: readonly string[] = ['==', '!=', '<', '<=', '>', '>='];

type Node =
  | { k: 'identity' }
  | { k: 'literal'; value: Json }
  | { k: 'field'; of: Node; name: string }
  | { k: 'index'; of: Node; index: Node }
  | { k: 'iterate'; of: Node }
  | { k: 'try'; of: Node }
  | { k: 'pipe' | 'comma' | 'alt'; left: Node; right: Node }
  | { k: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { k: 'array'; of: Node | null }
  | { k: 'object'; entries: { key: Node; value: Node }[] }
  | { k: 'call'; name: string; args: Node[] };

const IDENTITY: Node = { k: 'identity' };
const KEYWORDS: Record<string, Json> = { true: true, false: false, null: null };

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.pipe();
    if (this.peek().t !== 'end') throw new QueryError(`Unexpected ${describe(this.peek())}`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { t: 'end' };
  }

  private next(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  private isPunct(v: string): boolean {
    const token = this.peek();
    return token.t === 'punct' && token.v === v;
  }

  private isWord(v: string): boolean {
    const token = this.peek();
    return token.t === 'ident' && token.v === v;
  }

  private accept(v: string): boolean {
    if (!this.isPunct(v)) return false;
    this.pos += 1;
    return true;
  }

  private expect(v: string): void {
    if (!this.accept(v)) throw new QueryError(`Expected "${v}" but found ${describe(this.peek())}`);
  }

  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new QueryError('Expression nested too deeply');
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private pipe(): Node {
    const left = this.comma();
    return this.accept('|') ? { k: 'pipe', left, right: this.nested(() => this.pipe()) } : left;
  }

  private comma(): Node {
    let node = this.alt();
    while (this.accept(',')) node = { k: 'comma', left: node, right: this.alt() };
    return node;
  }

  private alt(): Node {
    const left = this.or();
    return this.accept('//') ? { k: 'alt', left, right: this.nested(() => this.alt()) } : left;
  }

  private or(): Node {
    let node = this.and();
    while (this.isWord('or')) {
      this.pos += 1;
      node = { k: 'binary', op: 'or', left: node, right: this.and() };
    }
    return node;
  }

  private and(): Node {
    let node = this.compare();
    while (this.isWord('and')) {
      this.pos += 1;
      node = { k: 'binary', op: 'and', left: node, right: this.compare() };
    }
    return node;
  }

  private compare(): Node {
    const left = this.sum();
    const token = this.peek();
    if (token.t !== 'punct' || !COMPARISONS.includes(token.v)) return left;
    this.pos += 1;
    return { k: 'binary', op: token.v as BinaryOp, left, right: this.sum() };
  }

  private sum(): Node {
    let node = this.postfix();
    while (this.accept('+')) node = { k: 'binary', op: '+', left: node, right: this.postfix() };
    return node;
  }

  private postfix(): Node {
    let node = this.nested(() => this.term());
    for (;;) {
      const suffixed = this.suffix(node);
      if (!suffixed) return node;
      node = suffixed;
    }
  }

  /** `.a`, `."a"`, `[…]`, `[]` or `?` after a term, or null when there is none. */
  private suffix(of: Node): Node | null {
    const token = this.peek();
    if (token.t === 'field') {
      this.pos += 1;
      return { k: 'field', of, name: token.v };
    }
    if (this.isPunct('.') && this.tokens[this.pos + 1]?.t === 'string') {
      this.pos += 1;
      return { k: 'field', of, name: this.stringValue() };
    }
    if (this.accept('[')) return this.bracket(of);
    if (this.accept('?')) return { k: 'try', of };
    return null;
  }

  private stringValue(): string {
    const token = this.next();
    if (token.t !== 'string')
      throw new QueryError(`Expected a string but found ${describe(token)}`);
    return token.v;
  }

  /** After `[` following a term: `[]` iterates, `[e]` indexes. */
  private bracket(of: Node): Node {
    if (this.accept(']')) return { k: 'iterate', of };
    const index = this.nested(() => this.pipe());
    this.expect(']');
    return { k: 'index', of, index };
  }

  private term(): Node {
    const token = this.next();
    switch (token.t) {
      case 'field':
        return { k: 'field', of: IDENTITY, name: token.v };
      case 'string':
        return { k: 'literal', value: token.v };
      case 'number':
        return { k: 'literal', value: token.v };
      case 'ident':
        return this.word(token.v);
      case 'punct':
        return this.punctTerm(token.v);
      default:
        throw new QueryError('Unexpected end of expression');
    }
  }

  private punctTerm(v: string): Node {
    if (v === '.') return this.dot();
    if (v === '(') {
      const inner = this.pipe();
      this.expect(')');
      return inner;
    }
    if (v === '[') {
      if (this.accept(']')) return { k: 'array', of: null };
      const of = this.pipe();
      this.expect(']');
      return { k: 'array', of };
    }
    if (v === '{') return this.object();
    if (v === '-') return this.negative();
    throw new QueryError(`Unexpected "${v}"`);
  }

  /** `.` alone, or `."a key"`; `.[…]` is a suffix of it. */
  private dot(): Node {
    return this.peek().t === 'string'
      ? { k: 'field', of: IDENTITY, name: this.stringValue() }
      : IDENTITY;
  }

  private negative(): Node {
    const token = this.next();
    if (token.t !== 'number') throw new QueryError('Expected a number after "-"');
    return { k: 'literal', value: -token.v };
  }

  private word(name: string): Node {
    if (name in KEYWORDS) return { k: 'literal', value: KEYWORDS[name] ?? null };
    const args: Node[] = [];
    if (this.accept('(')) {
      do args.push(this.pipe());
      while (this.accept(';'));
      this.expect(')');
    }
    const fn = FUNCTIONS[`${name}/${args.length}`];
    if (!fn) throw new QueryError(`Unknown function ${name}/${args.length}`);
    return { k: 'call', name: `${name}/${args.length}`, args };
  }

  private object(): Node {
    const entries: { key: Node; value: Node }[] = [];
    if (this.accept('}')) return { k: 'object', entries };
    do entries.push(this.entry());
    while (this.accept(','));
    this.expect('}');
    return { k: 'object', entries };
  }

  /** `key: value`, `"key": value`, `(expr): value`, or the shorthand `key` for `key: .key`. */
  private entry(): { key: Node; value: Node } {
    const token = this.next();
    let key: Node;
    let shorthand: string | null = null;
    if (token.t === 'ident' || token.t === 'string') {
      key = { k: 'literal', value: token.v };
      shorthand = token.v;
    } else if (token.t === 'punct' && token.v === '(') {
      key = this.pipe();
      this.expect(')');
    } else {
      throw new QueryError(`Unexpected ${describe(token)} in an object`);
    }
    if (this.accept(':')) return { key, value: this.alt() };
    if (shorthand === null) throw new QueryError('Expected ":" after a computed key');
    return { key, value: { k: 'field', of: IDENTITY, name: shorthand } };
  }
}

function describe(token: Token): string {
  if (token.t === 'end') return 'the end of the expression';
  if (token.t === 'field') return `".${token.v}"`;
  return `"${String(token.v)}"`;
}

// ---------------------------------------------------------------- evaluation

type Eval = (node: Node, input: Json) => Json[];

const typeOf = (v: Json): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
};

const truthy = (v: Json): boolean => v !== null && v !== false;

function str(v: Json, fn: string): string {
  if (typeof v !== 'string') throw new QueryError(`${fn} needs a string, not ${typeOf(v)}`);
  return v;
}

/** One value per output of `arg`: functions taking a value (`join(", ")`) use each. */
const each = (ev: Eval, arg: Node, input: Json, fn: (a: Json) => Json): Json[] =>
  ev(arg, input).map(fn);

function length(v: Json): number {
  if (v === null) return 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (typeof v === 'object') return Object.keys(v).length;
  if (typeof v === 'number') return Math.abs(v);
  throw new QueryError('boolean has no length');
}

function keys(v: Json): Json {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isRecord(v)) return Object.keys(v).sort();
  throw new QueryError(`${typeOf(v)} has no keys`);
}

function has(v: Json, k: Json): boolean {
  if (Array.isArray(v) && typeof k === 'number') return k >= 0 && k < v.length;
  if (isRecord(v) && typeof k === 'string') return Object.hasOwn(v, k);
  throw new QueryError(`Cannot check whether ${typeOf(v)} has a ${typeOf(k)} key`);
}

const tostring = (v: Json): string => (typeof v === 'string' ? v : JSON.stringify(v));

function join(v: Json, sep: Json): string {
  if (!Array.isArray(v)) throw new QueryError(`Cannot join ${typeOf(v)}`);
  const s = str(sep, 'join');
  return v.map((x) => (x === null ? '' : tostring(x))).join(s);
}

type Fn = (input: Json, args: Node[], ev: Eval) => Json[];

const unary =
  (fn: (v: Json) => Json): Fn =>
  (input) => [fn(input)];

const withString =
  (fn: (v: string, a: string) => Json, name: string): Fn =>
  (input, [arg], ev) =>
    arg
      ? each(ev, arg, input, (a) => (typeof input === 'string' ? fn(input, str(a, name)) : input))
      : [];

const FUNCTIONS: Record<string, Fn> = {
  'empty/0': () => [],
  'not/0': unary((v) => !truthy(v)),
  'length/0': unary(length),
  'keys/0': unary(keys),
  'type/0': unary(typeOf),
  'tostring/0': unary(tostring),
  'tojson/0': unary((v) => JSON.stringify(v)),
  'ascii_downcase/0': unary((v) => str(v, 'ascii_downcase').toLowerCase()),
  'ascii_upcase/0': unary((v) => str(v, 'ascii_upcase').toUpperCase()),
  'first/0': unary((v) => (Array.isArray(v) ? (v[0] ?? null) : null)),
  'last/0': unary((v) => (Array.isArray(v) ? (v.at(-1) ?? null) : null)),
  'first/1': (input, [f], ev) => (f ? ev(f, input).slice(0, 1) : []),
  'select/1': (input, [f], ev) => (f && ev(f, input).some(truthy) ? [input] : []),
  'map/1': (input, [f], ev) => {
    if (!Array.isArray(input) || !f) throw new QueryError(`Cannot map over ${typeOf(input)}`);
    return [input.flatMap((x) => ev(f, x))];
  },
  'has/1': (input, [k], ev) => (k ? each(ev, k, input, (key) => has(input, key)) : []),
  'join/1': (input, [s], ev) => (s ? each(ev, s, input, (sep) => join(input, sep)) : []),
  'split/1': (input, [s], ev) =>
    s ? each(ev, s, input, (sep) => str(input, 'split').split(str(sep, 'split'))) : [],
  'ltrimstr/1': withString((v, a) => (v.startsWith(a) ? v.slice(a.length) : v), 'ltrimstr'),
  'rtrimstr/1': withString(
    (v, a) => (a !== '' && v.endsWith(a) ? v.slice(0, v.length - a.length) : v),
    'rtrimstr',
  ),
  'startswith/1': (input, [s], ev) =>
    s ? each(ev, s, input, (a) => str(input, 'startswith').startsWith(str(a, 'startswith'))) : [],
  'endswith/1': (input, [s], ev) =>
    s ? each(ev, s, input, (a) => str(input, 'endswith').endsWith(str(a, 'endswith'))) : [],
};

function field(v: Json, name: string): Json {
  if (v === null) return null;
  if (!isRecord(v)) throw new QueryError(`Cannot index ${typeOf(v)} with "${name}"`);
  return Object.hasOwn(v, name) ? (v[name] ?? null) : null;
}

function index(v: Json, i: Json): Json {
  if (typeof i === 'string') return field(v, i);
  if (typeof i !== 'number') throw new QueryError(`Cannot index with ${typeOf(i)}`);
  if (v === null) return null;
  if (!Array.isArray(v)) throw new QueryError(`Cannot index ${typeOf(v)} with a number`);
  return v.at(Math.trunc(i)) ?? null;
}

function iterate(v: Json): Json[] {
  if (Array.isArray(v)) return v;
  if (isRecord(v)) return Object.values(v);
  throw new QueryError(`Cannot iterate over ${typeOf(v)}`);
}

/** Orders values like jq: null < false < true < numbers < strings < arrays < objects. */
const RANKS: Record<string, number> = {
  null: 0,
  boolean: 1,
  number: 2,
  string: 3,
  array: 4,
  object: 5,
};

function compare(a: Json, b: Json): number {
  const ra = RANKS[typeOf(a)] ?? 0;
  const rb = RANKS[typeOf(b)] ?? 0;
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : Number(a > b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja < jb ? -1 : Number(ja > jb);
}

function add(a: Json, b: Json): Json {
  if (a === null) return b;
  if (b === null) return a;
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (isRecord(a) && isRecord(b)) return { ...a, ...b };
  throw new QueryError(`Cannot add ${typeOf(a)} and ${typeOf(b)}`);
}

function binary(op: BinaryOp, a: Json, b: Json): Json {
  switch (op) {
    case '+':
      return add(a, b);
    case '==':
      return compare(a, b) === 0;
    case '!=':
      return compare(a, b) !== 0;
    case '<':
      return compare(a, b) < 0;
    case '<=':
      return compare(a, b) <= 0;
    case '>':
      return compare(a, b) > 0;
    case '>=':
      return compare(a, b) >= 0;
    default:
      return op === 'and' ? truthy(a) && truthy(b) : truthy(a) || truthy(b);
  }
}

/** Every combination of the outputs of `left` and `right`, like jq (right varies fastest). */
function product(ev: Eval, left: Node, right: Node, input: Json): [Json, Json][] {
  const rs = ev(right, input);
  return ev(left, input).flatMap((l) => rs.map((r): [Json, Json] => [l, r]));
}

function objects(ev: Eval, entries: { key: Node; value: Node }[], input: Json): Json[] {
  let out: Record<string, Json>[] = [{}];
  for (const { key, value } of entries) {
    const keys = ev(key, input).map((k) => str(k, 'Object keys'));
    const values = ev(value, input);
    out = out.flatMap((o) => keys.flatMap((k) => values.map((v) => ({ ...o, [k]: v }))));
  }
  return out;
}

class Evaluator {
  private produced = 0;

  readonly ev: Eval = (node, input) => {
    const out = this.step(node, input);
    this.produced += out.length;
    if (this.produced > MAX_OUTPUTS) throw new QueryError('The expression yields too many values');
    return out;
  };

  private step(node: Node, input: Json): Json[] {
    const { ev } = this;
    switch (node.k) {
      case 'identity':
        return [input];
      case 'literal':
        return [node.value];
      case 'field':
        return ev(node.of, input).map((v) => field(v, node.name));
      case 'index':
        return product(ev, node.of, node.index, input).map(([v, i]) => index(v, i));
      case 'iterate':
        return ev(node.of, input).flatMap(iterate);
      case 'try':
        return this.attempt(node.of, input);
      case 'pipe':
        return ev(node.left, input).flatMap((v) => ev(node.right, v));
      case 'comma':
        return [...ev(node.left, input), ...ev(node.right, input)];
      case 'alt':
        return this.alternative(node.left, node.right, input);
      case 'binary':
        return product(ev, node.left, node.right, input).map(([a, b]) => binary(node.op, a, b));
      case 'array':
        return [node.of ? ev(node.of, input) : []];
      case 'object':
        return objects(ev, node.entries, input);
      default:
        return (FUNCTIONS[node.name] ?? (() => []))(input, node.args, ev);
    }
  }

  private attempt(node: Node, input: Json): Json[] {
    try {
      return this.ev(node, input);
    } catch (err) {
      if (err instanceof QueryError && !this.exhausted()) return [];
      throw err;
    }
  }

  private exhausted(): boolean {
    return this.produced > MAX_OUTPUTS;
  }

  /** `a // b`: the truthy outputs of `a`, or those of `b` when there are none (or `a` fails). */
  private alternative(left: Node, right: Node, input: Json): Json[] {
    const kept = this.attempt(left, input).filter(truthy);
    return kept.length > 0 ? kept : this.ev(right, input);
  }
}

/** A parsed expression, run on payloads. */
export interface PayloadQuery {
  readonly source: string;
  /** Every value the expression yields; throws `QueryError` when it fails. */
  run(input: unknown): Json[];
}

/** Parses an expression; throws `QueryError` with what is wrong. */
export function parseQuery(source: string): PayloadQuery {
  const trimmed = source.trim();
  if (trimmed === '') throw new QueryError('The expression is empty');
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new QueryError(`The expression is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  const node = new Parser(tokenize(trimmed)).parse();
  return {
    source: trimmed,
    run: (input) => new Evaluator().ev(node, toJson(input)),
  };
}

/** The payload as JSON values (`undefined` and functions dropped, like `JSON.stringify`). */
function toJson(input: unknown): Json {
  return input === undefined ? null : (JSON.parse(JSON.stringify(input)) as Json);
}
