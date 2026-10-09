/** Static frontend only. Rusty and automation keep their own deployments. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'x-frontend-worker': 'tincanban', 'x-frontend-release': env.RELEASE_SHA ?? 'unknown' };
    if (url.pathname === '/health') return new Response('healthy\n', { headers: { ...headers, 'cache-control': 'no-store' } });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && !/\.[^/]+$/.test(url.pathname) && !/^\/(?:assets|mesh)\//.test(url.pathname)) {
      url.pathname = '/';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    const outputHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) outputHeaders.set(name, value);
    outputHeaders.set('x-content-type-options', 'nosniff');
    outputHeaders.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (outputHeaders.get('content-type')?.includes('text/html') || url.pathname === '/release.json') outputHeaders.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers: outputHeaders });
  },
};
