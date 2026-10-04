import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sourceDigest} from '../scripts/decision-bench.mjs';

test('source fingerprints match for LF and CRLF checkouts and detect changed code', async () => {
  const parent = path.resolve(tmpdir());
  const fixture = await mkdtemp(path.join(parent, 'vector-run-digest-'));
  const files = ['dist/engine.js', 'dist/app.js', 'scripts/decision-bench.mjs', 'scripts/verify-decision-trace.mjs'];
  try {
    for (const format of ['lf', 'crlf']) {
      for (const file of files) {
        const target = path.join(fixture, format, file);
        await mkdir(path.dirname(target), {recursive: true});
        const text = `// ${file}\nexport const value = 1;\n`;
        await writeFile(target, format === 'lf' ? text : text.replace(/\n/g, '\r\n'));
      }
    }
    const expected = await sourceDigest(path.join(fixture, 'lf'));
    assert.equal(await sourceDigest(path.join(fixture, 'crlf')), expected);
    await writeFile(path.join(fixture, 'lf', files[0]), 'export const value = 2;\n');
    assert.notEqual(await sourceDigest(path.join(fixture, 'lf')), expected);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('vector-run-digest-'));
    await rm(fixture, {recursive: true, force: true});
  }
});
