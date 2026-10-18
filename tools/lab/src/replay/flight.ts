import { parse } from 'parse5';

type Remap = (text: string) => string;

// React Flight uses byte-length rows for text and typed arrays, rather than a
// newline delimiter. Typed-array contents are opaque and must not be remapped.
const lengthTags = new Set('TAOoUSsLlGgMmV');

/** Remap textual Flight rows and repair UTF-8 byte lengths of T records. */
export function remapFlightText(text: string, remap: Remap): string {
  if (remap(text) === text) return text;
  const input = Buffer.from(text, 'utf8');
  const output: Buffer[] = [];
  let offset = 0;
  while (offset < input.length) {
    const colon = input.indexOf(58, offset);
    // React emits anonymous resource hints as :HL[...], with no row ID.
    if (colon < 0 || !/^[\da-f]*$/i.test(input.subarray(offset, colon).toString('ascii'))) {
      throw new Error(`Unsupported React Flight row at byte ${offset}`);
    }
    const tag = String.fromCharCode(input[colon + 1]);
    if (lengthTags.has(tag)) {
      const comma = input.indexOf(44, colon + 2);
      const rawLength = comma < 0 ? '' : input.subarray(colon + 2, comma).toString('ascii');
      if (!/^[\da-f]+$/i.test(rawLength)) throw new Error(`Invalid React Flight length at byte ${offset}`);
      const length = Number.parseInt(rawLength, 16);
      const end = comma + 1 + length;
      if (!Number.isSafeInteger(length) || end > input.length) throw new Error(`Truncated React Flight record at byte ${offset}`);
      const payload = input.subarray(comma + 1, end);
      if (tag === 'T') {
        const original = payload.toString('utf8');
        // A boundary inside a UTF-8 character is malformed framing, not a
        // reason to silently insert replacement characters into the stream.
        if (!Buffer.from(original, 'utf8').equals(payload)) throw new Error(`Invalid React Flight UTF-8 text at byte ${offset}`);
        const changed = remap(original);
        if (changed === original) output.push(input.subarray(offset, end));
        else output.push(Buffer.from(`${input.subarray(offset, colon + 2).toString('ascii')}${Buffer.byteLength(changed, 'utf8').toString(16)},${changed}`, 'utf8'));
      } else output.push(input.subarray(offset, end));
      offset = end;
    } else {
      const newline = input.indexOf(10, colon + 1);
      const end = newline < 0 ? input.length : newline + 1;
      output.push(Buffer.from(remap(input.subarray(offset, end).toString('utf8')), 'utf8'));
      offset = end;
    }
  }
  return Buffer.concat(output).toString('utf8');
}

interface FlightChunk { start: number; end: number; payload: string }

function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i + 1;
  }
  throw new Error('Unterminated JavaScript string in inline Flight script');
}

/** Locate the canonical Next push calls without matching string/comment text. */
function scriptChunks(source: string, sourceOffset: number): FlightChunk[] {
  const chunks: FlightChunk[] = [];
  const push = /self\s*\.\s*__next_f\s*\.\s*push\s*\(\s*/y;
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') { i = skipQuoted(source, i); continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment in inline Flight script');
      i = end + 2; continue;
    }
    push.lastIndex = i;
    const match = (i === 0 || !/[\w$.]/.test(source[i - 1])) ? push.exec(source) : null;
    if (!match) { i++; continue; }
    const start = push.lastIndex;
    if (source[start] !== '[') throw new Error('Unsupported nonliteral inline React Flight push');
    let depth = 0, end = start;
    for (; end < source.length; end++) {
      if (source[end] === '"') { end = skipQuoted(source, end) - 1; continue; }
      if (source[end] === '[') depth++;
      else if (source[end] === ']' && --depth === 0) { end++; break; }
    }
    let value: unknown;
    try { value = JSON.parse(source.slice(start, end)); }
    catch { throw new Error('Unsupported non-JSON inline React Flight push'); }
    if (!Array.isArray(value)) throw new Error('Invalid inline React Flight push');
    if (value[0] === 3) throw new Error('Unsupported binary inline React Flight channel 3');
    if (value[0] === 1) {
      if (value.length !== 2 || typeof value[1] !== 'string') throw new Error('Unsupported inline React Flight channel 1 payload');
      chunks.push({ start: sourceOffset + start, end: sourceOffset + end, payload: value[1] });
    } else if (value[0] !== 0 && value[0] !== 2) throw new Error(`Unsupported inline React Flight channel ${String(value[0])}`);
    i = end;
  }
  return chunks;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

/**
 * Apply remapping to HTML exactly once, protecting inline Flight byte framing.
 * Next can split a length record or even a surrogate pair across script calls,
 * so join channel 1 before parsing. Changed data is placed in its first call;
 * later calls remain in position with empty strings. Other script code and
 * channel 0 initialization retain their original order and spelling.
 * Do not apply a second raw remap to the returned HTML.
 */
export function remapHtmlFlight(html: string, remap: Remap): string {
  if (!html.includes('__next_f')) return remap(html);
  const chunks: FlightChunk[] = [];
  const document = parse(html, { sourceCodeLocationInfo: true });
  const visit = (node: any): void => {
    if (node.tagName === 'script' && !node.attrs?.some((attribute: any) => attribute.name === 'src')) {
      const location = node.sourceCodeLocation;
      if (location?.startTag && location?.endTag) {
        const start = location.startTag.endOffset, end = location.endTag.startOffset;
        const source = html.slice(start, end);
        if (source.includes('__next_f')) chunks.push(...scriptChunks(source, start));
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(document);
  if (!chunks.length) return remap(html);
  chunks.sort((a, b) => a.start - b.start);
  const stream = chunks.map(chunk => chunk.payload).join('');
  const changedStream = remapFlightText(stream, remap);
  const changed = changedStream !== stream;
  let offset = 0;
  const output: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    output.push(remap(html.slice(offset, chunk.start)));
    output.push(changed ? safeJson([1, i === 0 ? changedStream : '']) : html.slice(chunk.start, chunk.end));
    offset = chunk.end;
  }
  output.push(remap(html.slice(offset)));
  return output.join('');
}
