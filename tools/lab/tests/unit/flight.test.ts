import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { remapFlightText, remapHtmlFlight } from '../../src/replay/flight.js';

const origin = 'https://example.test';
const remap = (text: string) => text.replaceAll(origin, '');
const textRow = (id: string, text: string) => `${id}:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`;

test('Anonymous resource hints retain framing alongside remapped text records', () => {
  const input = `:HL["${origin}/style.css","style"]\n${textRow('c', origin)}d:null\n`;
  assert.equal(remapFlightText(input, remap), `:HL["/style.css","style"]\n${textRow('c', '')}d:null\n`);
});

function inlineChunks(html: string): unknown[][] {
  const self = { __next_f: [] as unknown[][] };
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(match[1], { self });
  return JSON.parse(JSON.stringify(self.__next_f));
}

test('Flight text remapping updates byte lengths without consuming the next row', () => {
  const payload = JSON.stringify({ url: `${origin}/about`, description: 'é 🐦 "quoted"\nnext' });
  const input = `0:{"url":"${origin}/"}\n${textRow('c', payload)}d:["$c",{"url":"${origin}/asset"}]\n`;
  const output = remapFlightText(input, remap);
  const changedPayload = remap(payload);
  assert.equal(output, `0:{"url":"/"}\n${textRow('c', changedPayload)}d:["$c",{"url":"/asset"}]\n`);
  const bytes = Buffer.from(output), start = output.indexOf('c:T'), comma = bytes.indexOf(44, start);
  const length = Number.parseInt(bytes.subarray(start + 3, comma).toString(), 16);
  assert.deepEqual(JSON.parse(bytes.subarray(comma + 1, comma + 1 + length).toString()), JSON.parse(changedPayload));
  assert.equal(bytes.subarray(comma + 1 + length, comma + 3 + length).toString(), 'd:');
});

test('Flight T payloads contain raw newlines, apparent row headers, quotes and multibyte characters', () => {
  const payload = `é 🐦\n1:Tbad,"${origin}"\n`;
  assert.equal(remapFlightText(textRow('a', payload) + 'b:null\n', remap), textRow('a', remap(payload)) + 'b:null\n');
});

test('Typed binary records remain opaque even when their bytes resemble a remappable URL', () => {
  for (const tag of 'AOoUSsLlGgMmV') {
    const payload = `${origin}\n0:T9,not a row`;
    const row = `a:${tag}${Buffer.byteLength(payload).toString(16)},${payload}`;
    assert.equal(remapFlightText(row + textRow('b', `${origin}/text`), remap), row + textRow('b', '/text'));
    assert.equal(remapFlightText(row, remap), row);
  }
});

test('Unchanged Flight remaps preserve original framing bytes exactly', () => {
  const input = '0:Ta,short';
  assert.equal(remapFlightText(input, text => text), input);
  const uppercase = 'a:T0A,0123456789b:null\n';
  assert.equal(remapFlightText(uppercase, remap), uppercase);
});

test('Malformed or truncated changed Flight lengths fail explicitly', () => {
  assert.throws(() => remapFlightText(`0:Tffff,${origin}`, remap), /Truncated React Flight/);
  assert.throws(() => remapFlightText(`0:Txyz,${origin}`, remap), /Invalid React Flight length/);
});

test('HTML Flight chunks join before byte repair, including split UTF-16 surrogate pairs', () => {
  const payload = `prefix 🐦\n"${origin}/x"\n`;
  const stream = `0:null\n${textRow('c', payload)}d:["$c"]\n`;
  const bird = stream.indexOf('🐦');
  const slices = [stream.slice(0, 10), stream.slice(10, bird + 1), stream.slice(bird + 1)];
  const input = '<!doctype html><script>(self.__next_f=self.__next_f||[]).push([0]);</script>' + slices.map(value => `<script>self.__next_f.push(${JSON.stringify([1, value])})</script>`).join('');
  const output = remapHtmlFlight(input, remap);
  const values = inlineChunks(output);
  assert.deepEqual(values[0], [0]);
  assert.equal(values.filter(value => value[0] === 1).map(value => value[1]).join(''), `0:null\n${textRow('c', remap(payload))}d:["$c"]\n`);
  assert.equal(values[2][1], '');
  assert.equal(values[3][1], '');
});

test('A URL split between inline chunks still remaps when raw HTML has no whole origin', () => {
  const stream = textRow('c', origin);
  const split = stream.indexOf('example') + 3;
  const input = [stream.slice(0, split), stream.slice(split)].map(value => `<script>self.__next_f.push(${JSON.stringify([1, value])})</script>`).join('');
  assert.equal(remap(input), input);
  assert.equal(inlineChunks(remapHtmlFlight(input, remap))[0][1], 'c:T0,');
});

test('HTML remaps nonflight content once while preserving init calls and other script order', () => {
  const payload = textRow('c', `${origin}/text`);
  const init = '(self.__next_f=self.__next_f||[]).push([0]);';
  const input = `<a href="${origin}/work">Work</a><script>${init}self.before="${origin}/before";self.__next_f.push(${JSON.stringify([1, payload])});self.after="${origin}/after";</script><script>self.ordinary="${origin}/ordinary";</script>`;
  let count = 0;
  const once = (text: string) => { count++; return text.replaceAll(origin, '/local'); };
  const output = remapHtmlFlight(input, once);
  assert.match(output, /href="\/local\/work"/);
  assert.ok(output.includes(init));
  assert.match(output, /self\.before="\/local\/before"/);
  assert.match(output, /self\.after="\/local\/after"/);
  assert.match(output, /self\.ordinary="\/local\/ordinary"/);
  assert.equal(inlineChunks(output)[1][1], textRow('c', '/local/text'));
  assert.ok(count > 0);
});

test('HTML serialization cannot close its script and escapes Unicode separators', () => {
  const payload = `${origin}/x</script>\u2028\u2029`;
  const safe = JSON.stringify([1, textRow('c', payload)]).replaceAll('<', '\\u003c');
  const output = remapHtmlFlight(`<script>self.__next_f.push(${safe})</script>`, remap);
  assert.equal((output.match(/<\/script>/g) ?? []).length, 1);
  assert.ok(output.includes('\\u003c/script>'));
  assert.ok(output.includes('\\u2028\\u2029'));
  assert.equal(inlineChunks(output)[0][1], textRow('c', remap(payload)));
});

test('Nonflight scripts and unchanged HTML preserve exact spelling and comments', () => {
  const payload = '0:null\n';
  const input = `<HTML><script>// self.__next_f.push([3,"ignored"]);\nself.note='self.__next_f.push([3,"string"])';self.__next_f.push([1,${JSON.stringify(payload)}]);/* keep */</script></HTML>`;
  assert.equal(remapHtmlFlight(input, text => text), input);
  assert.equal(remapHtmlFlight('<SCRIPT>self.x=1</SCRIPT>', text => text), '<SCRIPT>self.x=1</SCRIPT>');
});

test('Binary channel 3 and unsupported inline payloads fail without silently corrupting data', () => {
  assert.throws(() => remapHtmlFlight('<script>self.__next_f.push([3,"YWJj"])</script>', remap), /Unsupported binary/);
  assert.throws(() => remapHtmlFlight('<script>self.__next_f.push([1,42])</script>', remap), /Unsupported inline.*payload/);
});
