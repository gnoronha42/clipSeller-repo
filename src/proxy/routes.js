/**
 * Proxy reverso para APIs de IA usadas pelo ClipSeller HTML.
 * Adaptado de seller-ia-club/sellerEdit/backend/routes/csProxyRoutes.js — versão
 * standalone sem dependência de cota de relatórios.
 */
import { Router } from 'express';
import https from 'node:https';
import { URL } from 'node:url';
import { saveDataUriFrame } from '../media/lzFrame.js';
import { shrinkLaozhangSeedanceBody } from '../media/kieFramePublish.js';

export const proxyRouter = Router();

const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;
const LAOZHANG_UPSTREAM_TIMEOUT_MS = Number(process.env.LAOZHANG_UPSTREAM_TIMEOUT_MS) || 600000;
const LAOZHANG_CREATE_TIMEOUT_MS = Number(process.env.LAOZHANG_CREATE_TIMEOUT_MS) || 90000;
const LAOZHANG_POLL_TIMEOUT_MS = Number(process.env.LAOZHANG_POLL_TIMEOUT_MS) || 15000;
const LAOZHANG_RETRY_DELAYS_MS = [0, 2000, 5000, 10000];
const LAOZHANG_CREATE_RETRY_DELAYS_MS = [0, 2500];

const TARGETS = {
  anthropic: 'https://api.anthropic.com',
  replicate: 'https://api.replicate.com',
  fal: 'https://fal.run',
  falai: 'https://fal.ai',
  falcdn: 'https://rest.alpha.fal.ai',
  falqueue: 'https://queue.fal.run',
  openai: 'https://api.openai.com',
  freepik: 'https://api.freepik.com',
  fashn: 'https://api.fashn.ai',
  elevenlabs: 'https://api.elevenlabs.io',
  kie: 'https://api.kie.ai',
  kieupload: 'https://kieai.redpandaai.co/api',
  laozhang: 'https://api.laozhang.ai',
  google: 'https://generativelanguage.googleapis.com',
  evolink: 'https://api.evolink.ai',
  piapi: 'https://api.piapi.ai',
  // alvo dinâmico via SUPABASE_URL
  supabase: 'https://placeholder.supabase.co',
};

const KEY_MAP = {
  anthropic: 'ANTHROPIC_API_KEY',
  replicate: 'REPLICATE_API_KEY',
  fal: 'FAL_API_KEY',
  falai: 'FAL_API_KEY',
  falcdn: 'FAL_API_KEY',
  falqueue: 'FAL_API_KEY',
  openai: 'OPENAI_API_KEY',
  freepik: 'FREEPIK_API_KEY',
  fashn: 'FASHN_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  kie: 'KIE_API_KEY',
  kieupload: 'KIE_API_KEY',
  laozhang: 'LAOZHANG_API_KEY',
  google: 'GEMINI_API_KEY',
  evolink: 'EVOLINK_API_KEY',
  piapi: 'PIAPI_API_KEY',
  supabase: 'SUPABASE_ANON_KEY',
};

function resolveSupabaseBase() {
  return String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}

function pickLaozhangKey(bodyText) {
  let model = '';
  try {
    const parsed = JSON.parse(bodyText || '{}');
    model = String((parsed && parsed.model) || '').toLowerCase();
  } catch (_) {
    /* body não é JSON */
  }
  const def = process.env.LAOZHANG_API_KEY || '';
  if (!model) return def;
  if (model === 'sora-2' || model.startsWith('gpt-image')) {
    return process.env.LAOZHANG_SORA_API_KEY || def;
  }
  if (model === 'gemini-3-pro-image-preview' || model.includes('nano-banana')) {
    return process.env.LAOZHANG_IMAGE_API_KEY || def;
  }
  return def;
}

function injectAuth(provider, headers, bodyText) {
  if (provider === 'laozhang') {
    const key = pickLaozhangKey(bodyText);
    if (!key) return { ok: false };
    delete headers['authorization'];
    delete headers['Authorization'];
    headers['Authorization'] = `Bearer ${key}`;
    return { ok: true };
  }
  if (provider === 'google') {
    const key = process.env[KEY_MAP[provider]];
    if (!key) return { ok: false };
    delete headers['authorization'];
    delete headers['Authorization'];
    return { ok: true, queryKey: key };
  }
  if (provider === 'supabase') {
    const key = process.env.SUPABASE_ANON_KEY || '';
    if (!key || !resolveSupabaseBase()) return { ok: false };
    delete headers['authorization'];
    delete headers['Authorization'];
    delete headers['apikey'];
    headers['Authorization'] = `Bearer ${key}`;
    headers['apikey'] = key;
    return { ok: true };
  }
  const key = process.env[KEY_MAP[provider]];
  if (!key) return { ok: false };
  delete headers['authorization'];
  delete headers['Authorization'];
  delete headers['x-api-key'];
  delete headers['X-Api-Key'];
  switch (provider) {
    case 'anthropic':
      headers['x-api-key'] = key;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
      delete headers['anthropic-dangerous-direct-browser-access'];
      break;
    case 'replicate':
    case 'openai':
    case 'fashn':
    case 'kie':
    case 'kieupload':
    case 'evolink':
      headers['Authorization'] = `Bearer ${key}`;
      break;
    case 'piapi':
      headers['X-API-Key'] = key;
      break;
    case 'fal':
    case 'falai':
    case 'falcdn':
    case 'falqueue':
      headers['Authorization'] = `Key ${key}`;
      break;
    case 'freepik':
      headers['x-freepik-api-key'] = key;
      break;
    case 'elevenlabs':
      headers['xi-api-key'] = key;
      break;
    default:
      break;
  }
  return { ok: true };
}

function forceJsonContentType(provider, headers, hasBody) {
  if (!hasBody) return;
  if (!['anthropic', 'kie', 'kieupload', 'laozhang', 'openai', 'fashn'].includes(provider)) return;
  delete headers['content-type'];
  delete headers['Content-Type'];
  headers['Content-Type'] = 'application/json';
}

function logUpstreamError(provider, path, status, upstreamBody) {
  if (provider !== 'anthropic') return;
  let body = '';
  try { body = upstreamBody.toString('utf8'); } catch (_) {}
  if (!body) return;
  console.error(`[proxy][anthropic] upstream ${status} /${path}: ${body.slice(0, 2000)}`);
}

proxyRouter.get('/keys/status', (_req, res) => {
  const status = {};
  for (const [provider, envName] of Object.entries(KEY_MAP)) {
    status[provider] = !!process.env[envName];
  }
  status.laozhang_image = !!process.env.LAOZHANG_IMAGE_API_KEY;
  status.laozhang_sora = !!process.env.LAOZHANG_SORA_API_KEY;
  status.supabase_url = !!process.env.SUPABASE_URL;
  res.json(status);
});

for (const provider of Object.keys(TARGETS)) {
  proxyRouter.all(`/${provider}/*`, async (req, res) => {
    let targetBase = TARGETS[provider];
    if (provider === 'supabase') {
      targetBase = resolveSupabaseBase();
      if (!targetBase) {
        return res.status(400).json({ error: 'SUPABASE_URL não configurada no servidor.' });
      }
    }
    const path = req.params[0] || '';
    const qIdx = req.url.indexOf('?');
    const search = qIdx >= 0 ? req.url.slice(qIdx) : '';
    let url = `${targetBase}/${path}${search}`;

    const fwdHeaders = {};
    const skip = new Set([
      'host', 'origin', 'referer', 'connection',
      'content-length', 'transfer-encoding', 'cookie',
    ]);
    for (const [k, v] of Object.entries(req.headers)) {
      if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
    }

    let rawBody = Buffer.alloc(0);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rawBody = await getRawBody(req);
    }
    const bodyText = rawBody.length ? rawBody.toString('utf-8') : '';

    if (provider === 'kieupload' && req.method === 'POST' && path.includes('file-base64-upload')) {
      try {
        const local = await handleLocalKieUpload(bodyText, req);
        return res.json(local);
      } catch (err) {
        return res.status(400).json({ success: false, code: 400, msg: err.message || 'falha ao publicar imagem' });
      }
    }

    const authResult = injectAuth(provider, fwdHeaders, bodyText);
    if (!authResult.ok) {
      return res.status(400).json({
        error: `${KEY_MAP[provider]} não configurada no servidor.`,
      });
    }
    if (authResult.queryKey) {
      url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(authResult.queryKey);
    }
    forceJsonContentType(provider, fwdHeaders, rawBody.length > 0);

    if (provider === 'laozhang' && req.method === 'POST' && path.includes('contents/generations/tasks')) {
      try {
        rawBody = await shrinkLaozhangSeedanceBody(rawBody, bodyText);
      } catch (err) {
        console.warn(`[proxy][laozhang] shrink frame falhou: ${err.message}`);
        return res.status(502).json({
          error: `Não consegui publicar o frame para a Laozhang (${err.message}). Tente novamente ou aguarde alguns segundos.`,
          transient: true,
          provider: 'laozhang',
        });
      }
    }

    const fetchOpts = { method: req.method, headers: fwdHeaders };
    if (rawBody.length) {
      fetchOpts.body = rawBody;
      fwdHeaders['content-length'] = String(rawBody.length);
    }

    const startedAt = Date.now();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      console.log(`[proxy][${provider}] → ${req.method} /${path} (${rawBody.length}b)`);
    }
    try {
      let upstreamStatus = 502;
      let upstreamOk = false;
      let upstreamHeadersEntries = [];
      let upstreamBody = Buffer.alloc(0);

      if (provider === 'laozhang') {
        const upstream = await requestLaozhang(url, fetchOpts, LAOZHANG_UPSTREAM_TIMEOUT_MS);
        upstreamStatus = upstream.status;
        upstreamOk = upstream.status >= 200 && upstream.status < 300;
        upstreamHeadersEntries = Object.entries(upstream.headers || {});
        upstreamBody = upstream.body;
      } else {
        const upstream = await fetch(url, fetchOpts);
        upstreamStatus = upstream.status;
        upstreamOk = upstream.ok;
        upstreamHeadersEntries = Array.from(upstream.headers.entries());
        upstreamBody = Buffer.from(await upstream.arrayBuffer());
      }

      const elapsedMs = Date.now() - startedAt;
      if (req.method !== 'GET' || !upstreamOk || elapsedMs > 5000) {
        console.log(
          `[proxy][${provider}] ${req.method} /${path} → ${upstreamStatus} em ${(elapsedMs / 1000).toFixed(1)}s`,
        );
      }
      if (!upstreamOk) {
        logUpstreamError(provider, path, upstreamStatus, upstreamBody);
      }

      res.status(upstreamStatus);
      for (const [k, v] of upstreamHeadersEntries) {
        const lower = k.toLowerCase();
        if (lower === 'transfer-encoding' || lower === 'content-encoding') continue;
        if (lower.startsWith('access-control-')) continue;
        if (typeof v === 'undefined') continue;
        res.setHeader(k, v);
      }
      res.removeHeader('content-encoding');
      res.send(upstreamBody);
    } catch (err) {
      console.error(`[proxy][${provider}] ${req.method} ${url} → ${err.message}`);
      res.status(503).json({ error: `Proxy error (${provider}): ${err.message}`, transient: true });
    }
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isTransientUpstreamError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toUpperCase();
  return (
    msg.includes('aborted')
    || msg.includes('terminated')
    || msg.includes('operation was aborted')
    || msg.includes('socket hang up')
    || msg.includes('closed connection')
    || msg.includes('upstream deadline')
    || msg.includes('upstream timeout')
    || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)
  );
}

function isLaozhangBillablePost(method, url) {
  if (method !== 'POST') return false;
  const u = String(url || '').toLowerCase();
  return u.includes('/contents/generations/tasks')
    || u.includes('/videos')
    || u.includes('/images/generations');
}

function isTransientLaozhangHttpStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestLaozhang(url, fetchOpts, timeoutMs) {
  const billable = isLaozhangBillablePost(fetchOpts.method, url);
  const isPoll = fetchOpts.method === 'GET'
    && String(url).includes('/contents/generations/tasks/');
  if (billable) timeoutMs = Math.min(timeoutMs, LAOZHANG_CREATE_TIMEOUT_MS);
  else if (isPoll) timeoutMs = Math.min(timeoutMs, LAOZHANG_POLL_TIMEOUT_MS);
  const delays = billable ? LAOZHANG_CREATE_RETRY_DELAYS_MS : LAOZHANG_RETRY_DELAYS_MS;
  let lastErr;
  let lastResp;
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i];
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      if (billable) {
        const nbytes = fetchOpts.body ? fetchOpts.body.length : 0;
        console.log(`[proxy][laozhang] createTask POST tentativa ${i + 1}/${delays.length} (${nbytes}b)`);
      }
      const resp = await withAbsoluteTimeout(
        requestLaozhangFetch(url, fetchOpts, timeoutMs),
        timeoutMs + 2500,
        `laozhang upstream deadline after ${timeoutMs}ms`,
      );
      if (billable && isTransientLaozhangHttpStatus(resp.status) && i < delays.length - 1) {
        lastResp = resp;
        console.warn(`[proxy][laozhang] retry ${i + 1} após HTTP ${resp.status}`);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (billable && /deadline|upstream timeout/i.test(msg)) throw err;
      const transient = isTransientUpstreamError(err);
      if (!transient || i === delays.length - 1) throw err;
      const nbytes = fetchOpts.body ? fetchOpts.body.length : 0;
      console.warn(`[proxy][laozhang] retry ${i + 1} após ${err.code || err.message} (${nbytes}b)`);
    }
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

async function requestLaozhangFetch(url, fetchOpts, timeoutMs) {
  return requestLaozhangHttps(url, fetchOpts, timeoutMs);
}

function withAbsoluteTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function requestLaozhangHttps(url, fetchOpts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const hasBody = fetchOpts.body
      && fetchOpts.method !== 'GET'
      && fetchOpts.method !== 'HEAD';
    const headers = { ...fetchOpts.headers };
    if (hasBody) headers['content-length'] = String(fetchOpts.body.length);

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: fetchOpts.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(hardDeadline);
        resolve({
          status: res.statusCode || 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    // O evento 'timeout' do socket só dispara por INATIVIDADE. Se o upstream
    // mantiver a conexão viva sem nunca responder, ele não dispara — por isso
    // o prazo absoluto abaixo, que garante erro (→ 503 transient) no prazo.
    const hardDeadline = setTimeout(() => {
      const err = new Error(`upstream deadline after ${timeoutMs}ms`);
      req.destroy(err);
    }, timeoutMs + 500);

    req.on('timeout', () => {
      req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      clearTimeout(hardDeadline);
      reject(err);
    });

    if (hasBody) req.write(fetchOpts.body);
    req.end();
  });
}

async function handleLocalKieUpload(bodyText, req) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText || '{}');
  } catch (_) {
    throw new Error('JSON inválido');
  }
  const dataUri = parsed.base64Data || parsed.dataUrl || parsed.image || '';
  const downloadUrl = await saveDataUriFrame(dataUri, req);
  return {
    success: true,
    code: 200,
    msg: 'success',
    data: { downloadUrl, url: downloadUrl },
  };
}
