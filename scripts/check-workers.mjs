import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

// Execute the *bundled browser artifact* without a DOM. Unit-test resolution
// otherwise selects Node exports and can hide a browser-only dependency.
function worker(prefix, request) {
  const asset = readdirSync('dist/assets').find(name => name.startsWith(prefix + '-') && name.endsWith('.js'));
  assert.ok(asset, `Missing ${prefix} build artifact`);
  let response;
  const scope = { postMessage: result => { response = result; } };
  runInNewContext(readFileSync('dist/assets/' + asset, 'utf8'), {
    self: scope, TextEncoder, TextDecoder, URL, Intl, structuredClone,
    performance, console, setTimeout, clearTimeout,
  }, { timeout: 10000 });
  scope.onmessage({ data: request });
  assert.ok(response && !response.error, response?.error ?? 'worker did not reply');
  return response;
}
const text = readFileSync('fixtures/markdown/large-1mb.md', 'utf8');
const mapped = worker('mapping-worker', { docId: 'large', revision: 3, text }).map;
assert.equal(mapped.segments.map(segment => segment.source).join(''), text);
const entities = worker('mapping-worker', { docId: 'entities', revision: 0, text: 'A &amp; B &copy;.' }).map;
assert.equal(entities.blocks[0].node.children[0].decodedText, 'A & B ©.');
const edited = worker('direct-worker', { snapshot: { docId: 'direct', revision: 0, text: '# Heading\r\n\r\n<!-- protected -->\r\n' }, from: 2, to: 9, display: 'Changed' }).edit;
assert.equal(edited.expected, '# Changed\r\n\r\n<!-- protected -->\r\n');
console.log('Bundled workers: 1 MiB lossless mapping, named entities, and localized CRLF editing passed without DOM access.');
const tableSnapshot = { docId: 'empty-cell', revision: 0, text: '| A | B |\r\n|---|---|\r\n| x | |\r\n\r\n<!-- KEEP -->' };
const tableMap = worker('mapping-worker', tableSnapshot).map;
const cell = tableMap.blocks[0].node.children[1].children[1];
const cellEdit = worker('direct-worker', { snapshot: tableSnapshot, from: cell.range.from, to: cell.range.to, display: 'x|y' }).edit;
assert.equal(cellEdit.expected, '| A | B |\r\n|---|---|\r\n| x | x\\|y|\r\n\r\n<!-- KEEP -->');
console.log('M4 bundled worker: empty-cell literal pipe editing preserves table delimiters, CRLF and protected neighbors.');
