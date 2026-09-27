import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const approvedUpstream = 'https://telegram-ops-platform.onrender.com';
const defaultDist = fileURLToPath(new URL('../dist/', import.meta.url));
const defaultConfig = new URL('./staging-config.json', import.meta.url);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function readConfig(path = defaultConfig) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (!config || Object.keys(config).length !== 1 || config.upstream !== approvedUpstream)
    throw new Error('Invalid fixed staging configuration');
  return config;
}

function cleanHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase());
  for (const key of [...hopHeaders, ...nominated]) delete result[key];
  return result;
}

function apiError(res, status, code) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ error: code }));
}

// Only fixed route labels enter logs; arbitrary path segments and all query data are omitted.
const diagnosticPaths = new Set(['/v1', '/v1/', '/v1/me', '/v1/auth/login', '/v1/auth/logout',
  '/v1/mini/me', '/v1/mini/auth/exchange', '/v1/mini/auth/logout']);
const networkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function safeNetworkCode(error) { return networkCodes.has(error?.code) ? error.code : 'OTHER'; }
function safeContentType(value) {
  const mime = String(value ?? '').split(';')[0].trim().toLowerCase();
  return ['application/json', 'text/html', 'text/plain', 'application/octet-stream'].includes(mime)
    ? mime : (mime ? 'other' : 'absent');
}

// agent is an in-process TLS transport seam for isolated integration tests only.
// No request header, environment variable or config field can change the upstream.
export async function createStagingServer({ dist = defaultDist, configPath = defaultConfig,
  agent, timeoutMs = 15000, diagnostic = record => console.log(JSON.stringify(record)) } = {}) {
  const config = await readConfig(configPath);
  if (process.env.VITE_API_BASE) throw new Error('VITE_API_BASE must be empty');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Strict TLS required');
  const root = await realpath(dist);
  await stat(resolve(root, 'index.html'));
  const upstream = new URL(config.upstream);
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    const raw = req.url ?? '';
    // Accept only origin-form requests; never resolve client paths against upstream URL.
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
      apiError(res, 400, 'invalid_request_target'); return;
    }
    const path = raw.split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(path); }
    catch { apiError(res, 400, 'invalid_path'); return; }
    const isApi = path === '/v1' || path.startsWith('/v1/');
    if (isApi) {
      const correlationId = randomUUID();
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const base = { event: 'staging_proxy', correlation_id: correlationId,
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER',
        safe_path: diagnosticPaths.has(path) ? path : '/v1/:redacted' };
      const state = { upstream_status: null, upstream_content_type: null, network_error_code: null,
        timeout_classification: null, socket_reused: null, upstream_headers_ms: null,
        upstream_end_ms: null, classification: 'upstream_pending' };
      let finalized = false;
      const emit = fields => { try { diagnostic({ ...base, ...fields }); } catch { /* Diagnostics cannot affect transport. */ } };
      const finish = outcome => {
        if (finalized) return;
        finalized = true;
        emit({ phase: 'complete', timestamp: new Date().toISOString(), total_ms: elapsed(),
          ...state, classification: outcome ?? state.classification,
          proxy_status: res.headersSent ? res.statusCode : null });
      };
      res.setHeader('x-proxy-request-id', correlationId);
      emit({ phase: 'upstream_start', timestamp: new Date().toISOString() });
      res.once('finish', () => finish());
      res.once('close', () => finish(res.writableFinished ? undefined : 'downstream_closed'));
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      // Untrusted forwarding metadata must not influence upstream interpretation.
      for (const name of Object.keys(headers)) {
        if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
      }
      let reply;
      const outgoing = https.request({ protocol: 'https:', hostname: upstream.hostname,
        port: 443, servername: upstream.hostname, method: req.method, path: raw,
        headers, agent, rejectUnauthorized: true }, incoming => {
        reply = incoming;
        state.upstream_status = incoming.statusCode ?? null;
        state.upstream_content_type = safeContentType(incoming.headers['content-type']);
        state.upstream_headers_ms = elapsed();
        state.classification = incoming.statusCode >= 400 ? 'upstream_http_error' : 'upstream_response';
        incoming.once('end', () => { state.upstream_end_ms = elapsed(); });
        const responseHeaders = cleanHeaders(incoming.headers);
        responseHeaders['x-proxy-request-id'] = correlationId;
        responseHeaders['cache-control'] = 'no-store';
        responseHeaders['x-content-type-options'] = 'nosniff';
        res.writeHead(incoming.statusCode ?? 502, responseHeaders);
        incoming.on('error', error => { state.network_error_code = safeNetworkCode(error); state.classification = 'upstream_response_error'; outgoing.destroy(); apiError(res, 502, 'upstream_unavailable'); });
        incoming.pipe(res);
      });
      outgoing.once('socket', () => { state.socket_reused = outgoing.reusedSocket === true; });
      const timer = setTimeout(() => {
        state.timeout_classification = 'proxy_total_timeout'; state.classification = 'proxy_timeout';
        apiError(res, 504, 'upstream_timeout'); outgoing.destroy(); reply?.destroy();
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); };
      res.on('finish', cleanup);
      res.on('close', () => { cleanup(); outgoing.destroy(); reply?.destroy(); });
      req.on('aborted', () => outgoing.destroy());
      req.on('error', () => outgoing.destroy());
      outgoing.on('error', error => { cleanup(); if (!finalized && !state.timeout_classification) { state.network_error_code = safeNetworkCode(error); state.classification = 'upstream_network_error'; } apiError(res, 502, 'upstream_unavailable'); });
      req.pipe(outgoing);
      return;
    }
    // Encoded/traversal API aliases are invalid, never SPA navigation.
    if (decoded === '/v1' || decoded.startsWith('/v1/') || decoded.includes('\\') ||
        decoded.split('/').some(s => s === '..' || s.startsWith('.'))) {
      apiError(res, 400, 'invalid_path'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      apiError(res, 405, 'method_not_allowed'); return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}'); return;
    }
    try {
      let file = resolve(root, '.' + decoded);
      if (!file.startsWith(root + sep) && file !== root) {
        apiError(res, 400, 'invalid_path'); return;
      }
      let info;
      try { info = await stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!info?.isFile()) {
        const navigation = String(req.headers.accept ?? '').includes('text/html');
        if (!navigation || extname(decoded) || (decoded === '/assets' || decoded.startsWith('/assets/'))) {
          apiError(res, 404, 'not_found'); return;
        }
        file = resolve(root, 'index.html');
      }
      // Do not serve symlinks outside dist, config files or source files.
      file = await realpath(file);
      if (!file.startsWith(root + sep)) { apiError(res, 404, 'not_found'); return; }
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache' });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { apiError(res, 500, 'static_unavailable'); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
    const server = await createStagingServer();
    server.on('error', () => { console.error('Staging frontend failed'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log('Staging frontend listening'));
  } catch {
    console.error('Staging frontend configuration invalid'); process.exitCode = 1;
  }
}
