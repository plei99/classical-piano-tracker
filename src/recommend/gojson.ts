/**
 * Go `encoding/json` compatibility for decoding LLM and provider output.
 *
 * `JSON.parse` differs from Go's `json.Unmarshal` in ways users can see:
 * error wording (Go 1.27's v2-backed decoder reports e.g. "invalid character
 * 'o' in literal null (expecting 'u')"), struct field matching (exact, then
 * case-insensitive, last duplicate wins), `null` leaving fields untouched,
 * merging into existing values, invalid UTF-8 and lone surrogates becoming
 * U+FFFD, and type errors naming the Go type and field path. This module
 * mirrors those semantics: {@link parseGoJSON} validates and builds a syntax
 * tree from bytes, and the `goString`/`goStruct`/... decoders map that tree
 * onto typed values the way `json.Unmarshal` maps it onto Go structs.
 *
 * {@link goMarshal} is the matching encoder for Go maps and structs.
 */

const MAX_DEPTH = 10000;

export type JsonNode =
  | { kind: 'null'; start: number; end: number }
  | { kind: 'bool'; value: boolean; start: number; end: number }
  | { kind: 'number'; raw: string; start: number; end: number }
  | { kind: 'string'; value: string; start: number; end: number }
  | { kind: 'array'; items: JsonNode[]; start: number; end: number }
  | { kind: 'object'; entries: Array<[string, JsonNode]>; start: number; end: number };

/** A parsed document: the tree plus the bytes it came from (for raw values). */
export interface JsonDocument {
  root: JsonNode;
  bytes: Uint8Array;
}

/** Go's `*json.SyntaxError`. */
export class GoJSONSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntaxError';
  }
}

/** Go's `*json.UnmarshalTypeError`. */
export class GoJSONTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnmarshalTypeError';
  }
}

// ---------------------------------------------------------------------------
// Rune and quoting helpers (Go's utf8 and strconv semantics).

interface Rune {
  /** Code point, or -1 for an invalid byte (utf8.RuneError with size 1). */
  cp: number;
  size: number;
}

/** Go's `utf8.DecodeRune`. */
function decodeRune(b: Uint8Array, i: number): Rune {
  const c0 = b[i] as number;
  if (c0 < 0x80) {
    return { cp: c0, size: 1 };
  }
  const cont = (j: number): number => {
    const c = b[i + j];
    return c !== undefined && c >= 0x80 && c <= 0xbf ? c & 0x3f : -1;
  };
  if (c0 >= 0xc2 && c0 <= 0xdf) {
    const c1 = cont(1);
    return c1 < 0 ? { cp: -1, size: 1 } : { cp: ((c0 & 0x1f) << 6) | c1, size: 2 };
  }
  if (c0 >= 0xe0 && c0 <= 0xef) {
    const lo = c0 === 0xe0 ? 0xa0 : 0x80;
    const hi = c0 === 0xed ? 0x9f : 0xbf;
    const raw1 = b[i + 1];
    if (raw1 === undefined || raw1 < lo || raw1 > hi) {
      return { cp: -1, size: 1 };
    }
    const c2 = cont(2);
    return c2 < 0 ? { cp: -1, size: 1 } : { cp: ((c0 & 0x0f) << 12) | ((raw1 & 0x3f) << 6) | c2, size: 3 };
  }
  if (c0 >= 0xf0 && c0 <= 0xf4) {
    const lo = c0 === 0xf0 ? 0x90 : 0x80;
    const hi = c0 === 0xf4 ? 0x8f : 0xbf;
    const raw1 = b[i + 1];
    if (raw1 === undefined || raw1 < lo || raw1 > hi) {
      return { cp: -1, size: 1 };
    }
    const c2 = cont(2);
    const c3 = cont(3);
    if (c2 < 0 || c3 < 0) {
      return { cp: -1, size: 1 };
    }
    return { cp: ((c0 & 0x07) << 18) | ((raw1 & 0x3f) << 12) | (c2 << 6) | c3, size: 4 };
  }
  return { cp: -1, size: 1 };
}

/** Go's `utf8.FullRune`: false when the bytes are a truncated sequence. */
function fullRune(b: Uint8Array, i: number): boolean {
  const c0 = b[i] as number;
  const need = c0 >= 0xf0 && c0 <= 0xf4 ? 4 : c0 >= 0xe0 && c0 <= 0xef ? 3 : c0 >= 0xc2 && c0 <= 0xdf ? 2 : 1;
  const available = b.length - i;
  if (available >= need) {
    return true;
  }
  // A short sequence is only "not full" if every byte present is valid so far.
  for (let j = 1; j < available; j++) {
    const c = b[i + j] as number;
    if (j === 1) {
      const lo = c0 === 0xe0 ? 0xa0 : c0 === 0xf0 ? 0x90 : 0x80;
      const hi = c0 === 0xed ? 0x9f : c0 === 0xf4 ? 0x8f : 0xbf;
      if (c < lo || c > hi) {
        return true;
      }
    } else if (c < 0x80 || c > 0xbf) {
      return true;
    }
  }
  return false;
}

/** Go's `unicode.IsPrint` (letters, marks, numbers, punctuation, symbols, ASCII space). */
function isPrint(cp: number): boolean {
  if (cp === 0x20) {
    return true;
  }
  return /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(String.fromCodePoint(cp));
}

/** Go's `unicode.IsSpace`. */
function isSpace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

/** One rune escaped the way strconv.Quote/QuoteRune does. */
function escapeRune(cp: number, quote: string): string {
  if (cp === quote.codePointAt(0) || cp === 0x5c) {
    return `\\${String.fromCodePoint(cp)}`;
  }
  if (isPrint(cp)) {
    return String.fromCodePoint(cp);
  }
  const named: Record<number, string> = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' };
  const name = named[cp];
  if (name !== undefined) {
    return name;
  }
  if (cp < 0x20 || cp === 0x7f) {
    return `\\x${hex(cp, 2)}`;
  }
  return cp < 0x10000 ? `\\u${hex(cp, 4)}` : `\\U${hex(cp, 8)}`;
}

/** Go's `strconv.Quote` applied to raw bytes. */
function quoteBytes(b: Uint8Array): string {
  let out = '"';
  for (let i = 0; i < b.length;) {
    const r = decodeRune(b, i);
    out += r.cp < 0 ? `\\x${hex(b[i] as number, 2)}` : escapeRune(r.cp, '"');
    i += r.size;
  }
  return `${out}"`;
}

/** Go's `strconv.Quote` (the `%q` verb) for a string. */
export function goQuote(text: string): string {
  return quoteBytes(Buffer.from(text, 'utf8'));
}

/** jsonwire.QuoteRune: the first rune of `b`, single-quoted. */
function quoteFirstRune(b: Uint8Array): string {
  const r = decodeRune(b, 0);
  if (r.cp < 0) {
    return `'\\x${(b[0] as number).toString(16)}'`;
  }
  return `'${escapeRune(r.cp, "'")}'`;
}

function runeCount(b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < b.length; count++) {
    i += decodeRune(b, i).size;
  }
  return count;
}

/** jsonwire.InvalidTextError rendering. */
function invalidText(label: string, what: Uint8Array, where: string): string {
  let rendered: string;
  if (runeCount(what) === 1) {
    rendered = quoteFirstRune(what);
  } else {
    let needEscape = false;
    for (let i = 0; i < what.length;) {
      const r = decodeRune(what, i);
      if (r.cp < 0 || r.cp === 0x60 || r.cp === 0xfffd || isSpace(r.cp) || !isPrint(r.cp)) {
        needEscape = true;
      }
      i += r.size;
    }
    rendered = needEscape ? quoteBytes(what) : `\`${Buffer.from(what).toString('utf8')}\``;
  }
  return `invalid ${label} ${rendered} ${where}`.trimEnd();
}

// ---------------------------------------------------------------------------
// Parsing.

const EOF_MESSAGE = 'unexpected end of JSON input';

/**
 * Legacy (v1) rewording applied by Go to v2 syntax errors: drop the
 * "(expecting ...)" hint except for literals, then rename terms.
 */
function legacyMessage(message: string): string {
  const hint = message.indexOf(' (expecting');
  if (hint >= 0 && !message.includes(' in literal')) {
    message = message.slice(0, hint);
  }
  const replacements: Array<[string, string]> = [
    ['object name', 'object key'],
    ['at start of value', 'looking for beginning of value'],
    ['at start of string', 'looking for beginning of object key string'],
    ['after object value', 'after object key:value pair'],
    ['in number', 'in numeric literal'],
  ];
  for (const [from, to] of replacements) {
    message = message.replaceAll(from, to);
  }
  return message;
}

class EOFError extends Error {}

class Parser {
  private pos = 0;

  constructor(private readonly b: Uint8Array) {}

  private fail(message: string): never {
    throw new GoJSONSyntaxError(legacyMessage(message));
  }

  private eof(): never {
    throw new EOFError();
  }

  private invalidChar(where: string): never {
    // Go reports just the first rune of the remaining input.
    const size = this.pos < this.b.length ? decodeRune(this.b, this.pos).size : 0;
    this.fail(invalidText('character', this.b.subarray(this.pos, this.pos + size), where));
  }

  private skipWhitespace(): void {
    for (;;) {
      const c = this.b[this.pos];
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
        return;
      }
      this.pos++;
    }
  }

  /** Skips whitespace and requires at least one more byte. */
  private peek(): number {
    this.skipWhitespace();
    const c = this.b[this.pos];
    if (c === undefined) {
      this.eof();
    }
    return c;
  }

  parseDocument(): JsonNode {
    try {
      this.peek();
      const root = this.parseValue();
      this.skipWhitespace();
      if (this.pos < this.b.length) {
        this.invalidChar('after top-level value');
      }
      return root;
    } catch (err) {
      if (err instanceof EOFError) {
        throw new GoJSONSyntaxError(EOF_MESSAGE);
      }
      throw err;
    }
  }

  /**
   * Parses one value with an explicit stack: Go accepts nesting up to
   * 10000 levels, deeper than JavaScript recursion comfortably allows.
   */
  private parseValue(): JsonNode {
    type Frame =
      { node: Extract<JsonNode, { kind: 'array' }> } | { node: Extract<JsonNode, { kind: 'object' }>; key: string };
    const stack: Frame[] = [];
    let result: JsonNode | undefined;

    const open = (c: number): JsonNode | undefined => {
      const start = this.pos;
      if (c === 0x7b || c === 0x5b) {
        if (stack.length + 1 === MAX_DEPTH + 1) {
          this.fail('exceeded max depth');
        }
        this.pos++;
        const next = this.peek();
        if (c === 0x7b) {
          const node: JsonNode = { kind: 'object', entries: [], start, end: start };
          if (next === 0x7d) {
            this.pos++;
            node.end = this.pos;
            return node;
          }
          stack.push({ node, key: this.parseName() });
          return undefined;
        }
        const node: JsonNode = { kind: 'array', items: [], start, end: start };
        if (next === 0x5d) {
          this.pos++;
          node.end = this.pos;
          return node;
        }
        stack.push({ node });
        return undefined;
      }
      return this.parseScalar(c);
    };

    let pending = open(this.peek());
    for (;;) {
      if (pending === undefined) {
        // A container was opened; parse its first (or next) member value.
        pending = open(this.peek());
        continue;
      }
      const frame = stack.at(-1);
      if (frame === undefined) {
        result = pending;
        break;
      }
      // Attach the completed value, then look for a delimiter.
      const c = this.peek();
      if ('key' in frame) {
        frame.node.entries.push([frame.key, pending]);
        if (c === 0x2c) {
          this.pos++;
          this.peek();
          frame.key = this.parseName();
          pending = undefined;
          continue;
        }
        if (c !== 0x7d) {
          this.invalidChar("after object value (expecting ',' or '}')");
        }
      } else {
        frame.node.items.push(pending);
        if (c === 0x2c) {
          this.pos++;
          pending = undefined;
          continue;
        }
        if (c !== 0x5d) {
          this.invalidChar("after array element (expecting ',' or ']')");
        }
      }
      this.pos++;
      frame.node.end = this.pos;
      stack.pop();
      pending = frame.node;
    }
    return result;
  }

  /** Parses an object member name and its colon. */
  private parseName(): string {
    if (this.b[this.pos] !== 0x22) {
      this.invalidChar(`at start of string (expecting '"')`);
    }
    const name = this.parseString();
    if (this.peek() !== 0x3a) {
      this.invalidChar("after object name (expecting ':')");
    }
    this.pos++;
    this.peek();
    return name;
  }

  private parseScalar(c: number): JsonNode {
    const start = this.pos;
    switch (c) {
      case 0x6e:
        this.consumeLiteral('null');
        return { kind: 'null', start, end: this.pos };
      case 0x74:
        this.consumeLiteral('true');
        return { kind: 'bool', value: true, start, end: this.pos };
      case 0x66:
        this.consumeLiteral('false');
        return { kind: 'bool', value: false, start, end: this.pos };
      case 0x22: {
        const value = this.parseString();
        return { kind: 'string', value, start, end: this.pos };
      }
      default:
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
          this.consumeNumber();
          return {
            kind: 'number',
            raw: Buffer.from(this.b.subarray(start, this.pos)).toString('latin1'),
            start,
            end: this.pos,
          };
        }
        this.invalidChar('at start of value');
    }
  }

  private consumeLiteral(lit: string): void {
    for (let i = 0; i < lit.length; i++) {
      const c = this.b[this.pos + i];
      if (c === undefined) {
        this.eof();
      }
      if (c !== lit.charCodeAt(i)) {
        this.pos += i;
        this.invalidChar(`in literal ${lit} (expecting '${lit[i]}')`);
      }
    }
    this.pos += lit.length;
  }

  private digitAt(i: number): boolean {
    const c = this.b[i];
    return c !== undefined && c >= 0x30 && c <= 0x39;
  }

  private consumeNumber(): void {
    const b = this.b;
    let n = this.pos;
    if (b[n] === 0x2d) {
      n++;
    }
    const expectDigit = (): void => {
      if (n >= b.length) {
        this.eof();
      }
      if (!this.digitAt(n)) {
        this.pos = n;
        this.invalidChar('in number (expecting digit)');
      }
    };
    expectDigit();
    if (b[n] === 0x30) {
      n++;
    } else {
      while (this.digitAt(n)) {
        n++;
      }
    }
    if (b[n] === 0x2e) {
      n++;
      expectDigit();
      while (this.digitAt(n)) {
        n++;
      }
    }
    if (b[n] === 0x65 || b[n] === 0x45) {
      n++;
      if (b[n] === 0x2d || b[n] === 0x2b) {
        n++;
      }
      expectDigit();
      while (this.digitAt(n)) {
        n++;
      }
    }
    this.pos = n;
  }

  /** Validates and unquotes a string starting at the opening quote. */
  private parseString(): string {
    const b = this.b;
    let n = this.pos + 1;
    let out = '';
    let runStart = n;
    const flush = (end: number): void => {
      out += Buffer.from(b.subarray(runStart, end)).toString('utf8');
    };
    for (;;) {
      const c = b[n];
      if (c === undefined) {
        this.eof();
      }
      if (c === 0x22) {
        flush(n);
        this.pos = n + 1;
        return out;
      }
      if (c >= 0x20 && c < 0x80 && c !== 0x5c) {
        n++;
        continue;
      }
      if (c === 0x5c) {
        flush(n);
        const esc = b[n + 1];
        if (esc === undefined) {
          this.eof();
        }
        const simple: Record<number, string> = {
          0x22: '"',
          0x5c: '\\',
          0x2f: '/',
          0x62: '\b',
          0x66: '\f',
          0x6e: '\n',
          0x72: '\r',
          0x74: '\t',
        };
        const mapped = simple[esc];
        if (mapped !== undefined) {
          out += mapped;
          n += 2;
        } else if (esc === 0x75) {
          const high = this.parseHexEscape(n);
          n += 6;
          let cp = high;
          if (high >= 0xd800 && high <= 0xdfff) {
            cp = 0xfffd;
            const low = this.peekLowSurrogate(n);
            if (high <= 0xdbff && low !== undefined) {
              cp = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
              n += 6;
            }
          }
          out += String.fromCodePoint(cp);
        } else {
          this.failEscape(b.subarray(n, n + 2));
        }
        runStart = n;
        continue;
      }
      if (c < 0x20) {
        this.pos = n;
        this.invalidChar('in string (expecting non-control character)');
      }
      const r = decodeRune(b, n);
      if (r.cp >= 0) {
        n += r.size;
        continue;
      }
      if (!fullRune(b, n)) {
        this.eof();
      }
      // Invalid UTF-8 is accepted and replaced byte by byte, as in Go.
      flush(n);
      out += '�';
      n++;
      runStart = n;
    }
  }

  private failEscape(what: Uint8Array): never {
    this.fail(invalidText('escape sequence', what, 'in string'));
  }

  /** Parses `\uXXXX` at `n`, reporting Go's errors for bad or short escapes. */
  private parseHexEscape(n: number): number {
    const b = this.b;
    if (b.length < n + 6) {
      if (hasEscapedUTF16Prefix(b.subarray(n))) {
        this.eof();
      }
      this.failEscape(b.subarray(n));
    }
    const value = parseHex4(b.subarray(n + 2, n + 6));
    if (value === undefined) {
      this.failEscape(b.subarray(n, n + 6));
    }
    return value;
  }

  /** Returns the low surrogate escaped at `n`, if there is a valid one. */
  private peekLowSurrogate(n: number): number | undefined {
    const b = this.b;
    if (b.length < n + 6) {
      // A truncated `\uDCxx` prefix at the end of input is an EOF error.
      if (b.length > n && hasEscapedUTF16Prefix(b.subarray(n), true)) {
        this.eof();
      }
      return undefined;
    }
    if (b[n] !== 0x5c || b[n + 1] !== 0x75) {
      return undefined;
    }
    const value = parseHex4(b.subarray(n + 2, n + 6));
    return value !== undefined && value >= 0xdc00 && value <= 0xdfff ? value : undefined;
  }
}

function parseHex4(b: Uint8Array): number | undefined {
  if (b.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const c of b) {
    const digit =
      c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1;
    if (digit < 0) {
      return undefined;
    }
    value = value * 16 + digit;
  }
  return value;
}

/** jsonwire.hasEscapedUTF16Prefix. */
function hasEscapedUTF16Prefix(b: Uint8Array, lowerSurrogateHalf = false): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = b[i] as number;
    const isHex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
    if (i === 0 && c !== 0x5c) {
      return false;
    }
    if (i === 1 && c !== 0x75) {
      return false;
    }
    if (i === 2 && lowerSurrogateHalf && c !== 0x64 && c !== 0x44) {
      return false;
    }
    if (i === 3 && lowerSurrogateHalf && !((c >= 0x63 && c <= 0x66) || (c >= 0x43 && c <= 0x46))) {
      return false;
    }
    if (i >= 2 && i < 6 && !isHex) {
      return false;
    }
  }
  return true;
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
}

/** Validates and parses JSON with Go's syntax rules and error messages. */
export function parseGoJSON(input: string | Uint8Array): JsonDocument {
  const bytes = toBytes(input);
  return { root: new Parser(bytes).parseDocument(), bytes };
}

// ---------------------------------------------------------------------------
// Typed decoding with json.Unmarshal semantics.

interface DecodeContext {
  doc: JsonDocument;
  /** Name of the root struct type ("" for non-struct roots), as Go reports it. */
  root: string;
  path: string[];
}

/** Decodes one node into a value, merging into `current` like Go does. */
export interface GoDecoder<T> {
  zero(): T;
  decode(node: JsonNode, current: T, ctx: DecodeContext): T;
  /** Root struct name used in error paths. */
  readonly structName?: string;
}

const KIND_NAMES: Record<JsonNode['kind'], string> = {
  null: 'null',
  bool: 'bool',
  number: 'number',
  string: 'string',
  array: 'array',
  object: 'object',
};

function typeError(value: string, goType: string, ctx: DecodeContext): GoJSONTypeError {
  if (ctx.path.length === 0) {
    return new GoJSONTypeError(`json: cannot unmarshal ${value} into Go value of type ${goType}`);
  }
  const field = ctx.path.join('.');
  // Go's heuristic: a trailing all-digit path token is likely a slice index.
  const last = field.slice(field.lastIndexOf('.') + 1);
  const intoWhat = last !== '' && /^[0-9]+$/.test(last) ? '' : 'Go struct field ';
  return new GoJSONTypeError(`json: cannot unmarshal ${value} into ${intoWhat}${ctx.root}.${field} of type ${goType}`);
}

function mismatch(node: JsonNode, goType: string, ctx: DecodeContext): GoJSONTypeError {
  return typeError(KIND_NAMES[node.kind], goType, ctx);
}

/** Go `string`. JSON null leaves the current value unchanged. */
export const goString: GoDecoder<string> = {
  zero: () => '',
  decode(node, current, ctx) {
    if (node.kind === 'null') {
      return current;
    }
    if (node.kind !== 'string') {
      throw mismatch(node, 'string', ctx);
    }
    return node.value;
  },
};

/** Go `bool`. */
export const goBool: GoDecoder<boolean> = {
  zero: () => false,
  decode(node, current, ctx) {
    if (node.kind === 'null') {
      return current;
    }
    if (node.kind !== 'bool') {
      throw mismatch(node, 'bool', ctx);
    }
    return node.value;
  },
};

/** Go `json.RawMessage`: the value's exact text ("" when absent, "null" for null). */
export const goRawMessage: GoDecoder<string> = {
  zero: () => '',
  decode(node, _current, ctx) {
    return Buffer.from(ctx.doc.bytes.subarray(node.start, node.end)).toString('utf8');
  },
};

/** A decoded Go `any`: null, boolean, number, string, array, or map. */
export type GoAny = null | boolean | number | string | GoAny[] | GoMap;
/** A decoded `map[string]any`, with a null prototype so any key is safe. */
export type GoMap = { [key: string]: GoAny };

function newGoMap(): GoMap {
  return Object.create(null) as GoMap;
}

function decodeLeaf(node: JsonNode, ctx: DecodeContext): GoAny {
  switch (node.kind) {
    case 'null':
      return null;
    case 'bool':
    case 'string':
      return node.value;
    case 'number': {
      const value = Number(node.raw);
      if (!Number.isFinite(value)) {
        throw typeError(`number ${node.raw}`, 'float64', ctx);
      }
      return value;
    }
    case 'array':
      return [];
    case 'object':
      return newGoMap();
  }
}

/**
 * Converts a node to a Go `any` value. Iterative, because Go accepts
 * nesting up to 10000 levels, deeper than JavaScript recursion allows.
 */
function decodeAny(root: JsonNode, ctx: DecodeContext): GoAny {
  const result = decodeLeaf(root, ctx);
  if (root.kind !== 'array' && root.kind !== 'object') {
    return result;
  }
  type Frame = { node: JsonNode & { kind: 'array' | 'object' }; out: GoAny[] | GoMap; next: number };
  const stack: Frame[] = [{ node: root, out: result as GoAny[] | GoMap, next: 0 }];
  for (;;) {
    const top = stack.at(-1);
    if (top === undefined) {
      return result;
    }
    const size = top.node.kind === 'array' ? top.node.items.length : top.node.entries.length;
    if (top.next >= size) {
      stack.pop();
      if (stack.length > 0) {
        ctx.path.pop();
      }
      continue;
    }
    const idx = top.next++;
    const [key, child] =
      top.node.kind === 'array'
        ? [String(idx), top.node.items[idx] as JsonNode]
        : (top.node.entries[idx] as [string, JsonNode]);
    ctx.path.push(key);
    const value = decodeLeaf(child, ctx);
    if (Array.isArray(top.out)) {
      top.out.push(value);
    } else {
      top.out[key] = value;
    }
    if (child.kind === 'array' || child.kind === 'object') {
      stack.push({ node: child, out: value as GoAny[] | GoMap, next: 0 });
    } else {
      ctx.path.pop();
    }
  }
}

function withPath<T>(ctx: DecodeContext, segment: string, fn: () => T): T {
  ctx.path.push(segment);
  try {
    return fn();
  } finally {
    ctx.path.pop();
  }
}

/** Go `any`. */
export const goAny: GoDecoder<GoAny> = {
  zero: () => null,
  decode: (node, _current, ctx) => decodeAny(node, ctx),
};

/** Go `map[string]any`; null yields a nil map, objects merge into an existing one. */
export const goMapAny: GoDecoder<GoMap | null> = {
  zero: () => null,
  decode(node, current, ctx) {
    if (node.kind === 'null') {
      return null;
    }
    if (node.kind !== 'object') {
      throw mismatch(node, 'map[string]interface {}', ctx);
    }
    const map = current ?? newGoMap();
    for (const [key, value] of node.entries) {
      map[key] = withPath(ctx, key, () => decodeAny(value, ctx));
    }
    return map;
  },
};

/**
 * Go slice. Null yields an empty (nil) slice; arrays decode element by
 * element into existing elements, as Go reuses the backing array.
 */
export function goSlice<T>(elem: GoDecoder<T>, goType: string): GoDecoder<T[]> {
  return {
    zero: () => [],
    decode(node, current, ctx) {
      if (node.kind === 'null') {
        return [];
      }
      if (node.kind !== 'array') {
        throw mismatch(node, goType, ctx);
      }
      return node.items.map((item, idx) =>
        withPath(ctx, String(idx), () =>
          elem.decode(item, idx < current.length ? (current[idx] as T) : elem.zero(), ctx),
        ),
      );
    },
  };
}

export interface GoField {
  /** Property name on the TypeScript object. */
  prop: string;
  /** JSON name from the Go struct tag. */
  json: string;
  decoder: GoDecoder<unknown>;
}

/** Builds a field list entry; a typed helper so decoders stay checked. */
export function field<T>(prop: string, json: string, decoder: GoDecoder<T>): GoField {
  return { prop, json, decoder: decoder as GoDecoder<unknown> };
}

/**
 * Go struct. Members match fields by exact JSON name, then case-insensitively
 * (strings.EqualFold); unknown members are ignored and null leaves the
 * struct unchanged.
 */
export function goStruct<T extends object>(goType: string, fields: GoField[], structName?: string): GoDecoder<T> {
  const zero = (): T => {
    const value: Record<string, unknown> = {};
    for (const f of fields) {
      value[f.prop] = f.decoder.zero();
    }
    return value as T;
  };
  return {
    zero,
    structName: structName ?? goType.slice(goType.lastIndexOf('.') + 1),
    decode(node, current, ctx) {
      if (node.kind === 'null') {
        return current;
      }
      if (node.kind !== 'object') {
        throw mismatch(node, goType, ctx);
      }
      const target = { ...current } as Record<string, unknown>;
      for (const [key, value] of node.entries) {
        const match = fields.find((f) => f.json === key) ?? fields.find((f) => equalFold(f.json, key));
        if (match === undefined) {
          continue;
        }
        target[match.prop] = withPath(ctx, key, () => match.decoder.decode(value, target[match.prop], ctx));
      }
      return target as T;
    },
  };
}

/** Go pointer to struct: null yields null; type errors name the element type. */
export function goPointer<T>(elem: GoDecoder<T>): GoDecoder<T | null> {
  return {
    zero: () => null,
    decode(node, current, ctx) {
      if (node.kind === 'null') {
        return null;
      }
      return elem.decode(node, current ?? elem.zero(), ctx);
    },
  };
}

// strings.EqualFold, kept local to avoid a dependency cycle with gostrings.
function equalFold(a: string, b: string): boolean {
  const fold = (ch: string): string => {
    const upper = ch.toUpperCase();
    const lower = ([...upper].length === 1 ? upper : ch).toLowerCase();
    return [...lower].length === 1 ? lower : ch;
  };
  const left = [...a];
  const right = [...b];
  return (
    left.length === right.length &&
    left.every((ch, idx) => ch === right[idx] || fold(ch) === fold(right[idx] as string))
  );
}

/**
 * Go's `json.Unmarshal(data, &v)` for a fresh zero `v`: syntax errors first
 * (the whole input is validated before decoding), then the earliest type
 * error. Throws {@link GoJSONSyntaxError} or {@link GoJSONTypeError}.
 */
export function goUnmarshal<T>(input: string | Uint8Array, decoder: GoDecoder<T>): T {
  const doc = parseGoJSON(input);
  return decodeDocument(doc, decoder);
}

/** Decodes an already-parsed document (see {@link goUnmarshal}). */
export function decodeDocument<T>(doc: JsonDocument, decoder: GoDecoder<T>): T {
  const ctx: DecodeContext = { doc, root: decoder.structName ?? '', path: [] };
  return decoder.decode(doc.root, decoder.zero(), ctx);
}

// ---------------------------------------------------------------------------
// Encoding.

export interface GoMarshalOptions {
  /**
   * Sort object keys bytewise, as Go does for maps. Leave false for objects
   * that stand in for Go structs, whose keys keep declaration order.
   */
  sortKeys: boolean;
  /** Per-level indent, as in `json.MarshalIndent(v, "", indent)`. */
  indent?: string;
}

/**
 * Go's `json.Marshal` / `json.MarshalIndent`: HTML-safe string escaping,
 * Go's float formatting (including `-0`), and Go's errors for unsupported
 * values. Object properties set to `undefined` are omitted (omitempty).
 */
export function goMarshal(value: unknown, options: GoMarshalOptions): string {
  const indent = options.indent ?? '';
  const encode = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) {
      return 'null';
    }
    switch (typeof v) {
      case 'string':
        return encodeString(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) {
          throw new Error(`json: unsupported value: ${Number.isNaN(v) ? 'NaN' : v > 0 ? '+Inf' : '-Inf'}`);
        }
        // JavaScript's shortest round-trip formatting matches Go's float64
        // encoding, which uses exponents outside [1e-6, 1e21).
        return Object.is(v, -0) ? '-0' : JSON.stringify(v);
      case 'object':
        break;
      default:
        throw new Error(`json: unsupported type: ${typeof v}`);
    }
    const inner = indent === '' ? '' : `\n${indent.repeat(depth + 1)}`;
    const close = indent === '' ? '' : `\n${indent.repeat(depth)}`;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        return '[]';
      }
      return `[${v.map((item) => inner + encode(item, depth + 1)).join(',')}${close}]`;
    }
    const record = v as Record<string, unknown>;
    let keys = Object.keys(record).filter((key) => record[key] !== undefined);
    if (options.sortKeys) {
      keys = keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    }
    if (keys.length === 0) {
      return '{}';
    }
    const sep = indent === '' ? ':' : ': ';
    return `{${keys.map((key) => inner + encodeString(key) + sep + encode(record[key], depth + 1)).join(',')}${close}}`;
  };
  return encode(value, 0);
}

function encodeString(text: string): string {
  // Lone surrogates would be invalid UTF-8 in Go, which encodes them as U+FFFD.
  return JSON.stringify(text.toWellFormed()).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
