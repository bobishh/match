import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './frontend.mjs';

test('Given a release, when a deep link opens, then HTML stays on that URL and reports the release', async () => {
  const paths = [];
  const env = { RELEASE_SHA: 'abc', ASSETS: { fetch: async (request) => {
    paths.push(new URL(request.url).pathname);
    return paths.length === 1 ? new Response(null, { status: 404 }) : new Response('<html>board</html>', { headers: { 'content-type': 'text/html' } });
  } } };
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/pair'), env);
  assert.equal(result.status, 200);
  assert.deepEqual(paths, ['/pair', '/']);
  assert.equal(result.headers.get('x-frontend-release'), 'abc');
  assert.match(result.headers.get('cache-control'), /no-store/);
});

test('Given a missing chunk, when requested, then return 404 rather than HTML', async () => {
  let calls = 0;
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/assets/missing.js'), {
    ASSETS: { fetch: async () => { calls++; return new Response(null, { status: 404 }); } },
  });
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});

test('Given a health request, then report exact deployed SHA without reading assets', async () => {
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/health'), { RELEASE_SHA: 'abc' });
  assert.equal(result.headers.get('x-frontend-release'), 'abc');
  assert.equal(result.headers.get('x-frontend-worker'), 'tincanban');
});
