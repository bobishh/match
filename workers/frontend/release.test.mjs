import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, retainedAsset } from './release.mjs';

test('Given a checked artifact, when SHA or bytes differ, then refuse deployment', () => {
  const file = Buffer.from('built');
  const manifest = { sha: 'a'.repeat(40), files: { 'index.html': 'wrong' } };
  assert.throws(() => checkRelease(manifest, 'b'.repeat(40), () => file), /commit/);
  assert.throws(() => checkRelease(manifest, 'a'.repeat(40), () => file), /checksum/);
});
test('Given old assets, retain only fingerprinted chunks inside assets', () => {
  assert.equal(retainedAsset('assets/Board-Abc12345.js'), true);
  for (const path of ['../private', 'index.html', 'assets/../../secret-Abc12345.js', 'assets/config.js']) assert.equal(retainedAsset(path), false);
});

test('Given matching build bytes and SHA, then accept; reject unsafe manifest paths', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('built');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => checkRelease({ sha, files: { 'index.html': hash } }, sha, () => bytes));
  assert.throws(() => checkRelease({ sha, files: { 'index.html': hash, '../secret': hash } }, sha, () => bytes), /checksum/);
});
