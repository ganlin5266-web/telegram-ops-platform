import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createStagingServer, readConfig } from '../staging-server.mjs';

const targetHost = 'telegram-ops-platform.onrender.com';
let dir, upstream, server, agent, port, tlsOptions;
let captured = [], calls = 0;
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function request(path, { method = 'GET', headers = {}, body, serverPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: serverPort, path, method, headers }, res => {
      const parts = [];
      res.on('data', data => parts.push(data)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'staging-proxy-test-'));
  await mkdir(join(dir, 'dist/assets'), { recursive: true });
  await writeFile(join(dir, 'dist/index.html'), '<html>SPA_MARKER</html>');
  await writeFile(join(dir, 'dist/assets/app.js'), 'export const ok = true');
  await writeFile(join(dir, 'private.txt'), 'outside-dist');
  await symlink(join(dir, 'private.txt'), join(dir, 'dist/leak.txt'));
  // Temporary self-signed test certificate, trusted only by the injected test agent.
  // No private key fixture is committed or printed.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-subj', `/CN=${targetHost}`, '-addext', `subjectAltName=DNS:${targetHost}`], { stdio: 'ignore' });
  tlsOptions = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
  upstream = https.createServer(tlsOptions, async (req, res) => {
    calls++;
    const parts = []; for await (const chunk of req) parts.push(chunk);
    captured.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
    if (req.url === '/v1/timeout') return;
    if (req.url === '/v1/broken') { req.socket.destroy(); return; }
    if (req.url === '/v1/redirect') { res.writeHead(307, { location: 'https://example.invalid/never-follow' }); res.end(); return; }
    if (req.url === '/v1/cookies') {
      res.setHeader('set-cookie', ['__Host-example=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax',
        'example=synthetic; Domain=example.invalid; Path=/v1; SameSite=Strict; Secure; HttpOnly']);
    }
    res.setHeader('connection', 'x-hop-response'); res.setHeader('x-hop-response', 'remove');
    res.setHeader('cache-control', 'public, max-age=600');
    res.setHeader('content-type', 'application/json');
    const status = /^\/v1\/status\/(\d+)/.exec(req.url)?.[1];
    res.statusCode = status ? Number(status) : 200;
    res.end(JSON.stringify({ status: res.statusCode }));
  });
  const upstreamPort = await listen(upstream);
  agent = new https.Agent({ keepAlive: false });
  agent.createConnection = options => {
    assert.equal(options.hostname ?? options.host, targetHost);
    assert.equal(options.rejectUnauthorized, true);
    return tls.connect({ ...options, host: '127.0.0.1', port: upstreamPort,
      servername: targetHost, ca: tlsOptions.cert, rejectUnauthorized: true });
  };
  server = await createStagingServer({ dist: join(dir, 'dist'), agent, timeoutMs: 300 });
  port = await listen(server);
});
after(async () => { await close(server); await close(upstream); agent.destroy(); await rm(dir, { recursive: true, force: true }); });

test('fixed config only; missing, malformed, alternate target and extra config fail closed', async () => {
  assert.equal((await readConfig()).upstream, `https://${targetHost}`);
  await assert.rejects(readConfig(join(dir, 'missing.json')));
  for (const value of ['{', '{}', '{"upstream":"http://127.0.0.1:3000"}',
    JSON.stringify({ upstream: `https://${targetHost}/` }),
    JSON.stringify({ upstream: `https://${targetHost}`, override: true })]) {
    const path = join(dir, 'bad-config.json'); await writeFile(path, value);
    await assert.rejects(createStagingServer({ dist: join(dir, 'dist'), configPath: path }));
  }
});
test('reject nonempty browser base and insecure global TLS setting', async () => {
  for (const [key, value] of [['VITE_API_BASE', 'https://example.invalid'], ['NODE_TLS_REJECT_UNAUTHORIZED', '0']]) {
    const old = process.env[key]; process.env[key] = value;
    try { await assert.rejects(createStagingServer({ dist: join(dir, 'dist') })); }
    finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
});
test('GET path and query preserved; Host fixed; client target headers do not select upstream', async () => {
  const result = await request('/v1/users?cursor=a%2Bb&target=https%3A%2F%2Fevil.invalid', { headers: {
    host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid', forwarded: 'host=evil.invalid',
    'x-upstream': 'https://evil.invalid' } });
  assert.equal(result.status, 200);
  const last = captured.at(-1); assert.equal(last.headers.host, targetHost);
  assert.equal(last.url, '/v1/users?cursor=a%2Bb&target=https%3A%2F%2Fevil.invalid');
  assert.equal(last.headers['x-forwarded-host'], undefined); assert.equal(last.headers.forwarded, undefined);
});
test('POST raw body, Origin, Cookie, CSRF and Idempotency-Key preserved', async () => {
  const headers = { origin: 'https://frontend.example.invalid', cookie: 'session=synthetic',
    'x-csrf-protection': '1', 'x-csrf-token': 'synthetic-test-value', 'idempotency-key': 'test-event',
    authorization: 'Bearer synthetic-mini-session',
    'content-type': 'application/json', connection: 'x-hop-request', 'x-hop-request': 'remove' };
  const body = '{"test":"汉字", "number":"9007199254740901"}';
  const result = await request('/v1/auth/login?x=1', { method: 'POST', headers, body });
  assert.equal(result.status, 200);
  const last = captured.at(-1); assert.equal(last.method, 'POST'); assert.equal(last.body, body);
  for (const name of ['origin', 'cookie', 'authorization', 'x-csrf-protection', 'x-csrf-token', 'idempotency-key', 'content-type'])
    assert.equal(last.headers[name], headers[name]);
  assert.equal(last.headers['x-hop-request'], undefined);
  assert.equal(result.headers['x-hop-response'], undefined);
});
test('missing Origin is not invented; sandbox Origin is NOT rewritten', async () => {
  await request('/v1/me'); assert.equal(captured.at(-1).headers.origin, undefined);
  await request('/v1/me', { headers: { origin: 'http://localhost:8080' } });
  assert.equal(captured.at(-1).headers.origin, 'http://localhost:8080');
});
test('multiple Set-Cookie values and every attribute remain byte-identical', async () => {
  const response = await request('/v1/cookies');
  assert.deepEqual(response.headers['set-cookie'], ['__Host-example=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax',
    'example=synthetic; Domain=example.invalid; Path=/v1; SameSite=Strict; Secure; HttpOnly']);
});
for (const status of [401, 403, 404, 500]) test(`upstream ${status} body/status preserved, no-store, no SPA`, async () => {
  const response = await request(`/v1/status/${status}`, { headers: { accept: 'text/html' } });
  assert.equal(response.status, status); assert.equal(response.body, JSON.stringify({ status }));
  assert.equal(response.headers['cache-control'], 'no-store'); assert.doesNotMatch(response.body, /SPA_MARKER/);
});
for (const path of ['/v1', '/v1/', '/v1/unknown.js']) test(`${path} has absolute API priority`, async () => {
  const response = await request(path, { headers: { accept: 'text/html' } });
  assert.equal(response.headers['cache-control'], 'no-store'); assert.doesNotMatch(response.body, /SPA_MARKER/);
});
test('timeout returns JSON 504 and does not retry POST', async () => {
  const initial = calls;
  const response = await request('/v1/timeout', { method: 'POST', body: 'synthetic' });
  assert.equal(response.status, 504); assert.deepEqual(JSON.parse(response.body), { error: 'upstream_timeout' });
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(calls, initial + 1);
});
test('upstream disconnect returns JSON 502 and does not retry', async () => {
  const initial = calls; const response = await request('/v1/broken', { method: 'POST' });
  assert.equal(response.status, 502); assert.equal(JSON.parse(response.body).error, 'upstream_unavailable');
  assert.equal(calls, initial + 1);
});
test('connection refused returns JSON 502', async () => {
  const temporary = http.createServer(); const unused = await listen(temporary); await close(temporary);
  const refused = new https.Agent(); refused.createConnection = options => tls.connect({ ...options, host: '127.0.0.1', port: unused });
  const front = await createStagingServer({ dist: join(dir, 'dist'), agent: refused });
  try { const response = await request('/v1/me', { serverPort: await listen(front) }); assert.equal(response.status, 502); }
  finally { await close(front); refused.destroy(); }
});
test('untrusted HTTPS certificate rejected, not silently accepted', async () => {
  const untrusted = new https.Agent();
  untrusted.createConnection = options => tls.connect({ ...options, host: '127.0.0.1',
    port: upstream.address().port, servername: targetHost });
  const front = await createStagingServer({ dist: join(dir, 'dist'), agent: untrusted });
  try { const response = await request('/v1/me', { serverPort: await listen(front) }); assert.equal(response.status, 502); }
  finally { await close(front); untrusted.destroy(); }
});
test('redirect is returned without follow', async () => {
  const initial = calls; const response = await request('/v1/redirect');
  assert.equal(response.status, 307); assert.equal(response.headers.location, 'https://example.invalid/never-follow');
  assert.equal(calls, initial + 1);
});
for (const path of ['/', '/users', '/users/synthetic/details']) test(`SPA navigation ${path}`, async () => {
  const response = await request(path, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 200); assert.match(response.body, /SPA_MARKER/);
});
test('HEAD navigation has no body', async () => {
  const response = await request('/users', { method: 'HEAD', headers: { accept: 'text/html' } });
  assert.equal(response.status, 200); assert.equal(response.body, '');
});
test('static JS served with correct type', async () => {
  const response = await request('/assets/app.js'); assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /javascript/); assert.doesNotMatch(response.body, /SPA_MARKER/);
});
for (const path of ['/assets/missing.js', '/assets/missing', '/assets', '/missing.css', '/server/staging-config.json', '/leak.txt'])
  test(`missing/private resource ${path} never falls back`, async () => {
    const response = await request(path, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404); assert.doesNotMatch(response.body, /SPA_MARKER|outside-dist/);
  });
for (const path of ['https://evil.invalid/v1/me', '//evil.invalid/v1/me', '/%76%31/me', '/%2e%2e/private.txt', '/bad%ZZ'])
  test(`invalid request target ${path} rejected`, async () => {
    const initial = calls; const response = await request(path, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 400); assert.equal(calls, initial); assert.doesNotMatch(response.body, /SPA_MARKER/);
  });
test('non-API POST is not SPA fallback', async () => { assert.equal((await request('/users', { method: 'POST' })).status, 405); });
test('health is local and does not call API', async () => {
  const initial = calls; assert.deepEqual(JSON.parse((await request('/healthz')).body), { status: 'ok' }); assert.equal(calls, initial);
});
test('CLI invalid configuration fails without printing environment values', () => {
  const result = spawnSync(process.execPath, ['web/server/staging-server.mjs'], {
    cwd: new URL('../../../', import.meta.url), env: { ...process.env, PORT: 'invalid', VITE_API_BASE: 'synthetic-sensitive-canary' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-sensitive-canary/);
});
