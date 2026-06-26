/**
 * Proxy reverso para APIs de IA usadas pelo ClipSeller HTML.
 * Adaptado de seller-ia-club/sellerEdit/backend/routes/csProxyRoutes.js — versão
 * standalone sem dependência de cota de relatórios.
 */
import { Router } from 'express';
import https from 'node:https';

export const proxyRouter = Router();

const DEFAULT_UPSTREAM_TIMEOUT_MS = 25000;
const LAOZHANG_UPSTREAM_TIMEOUT_MS = 90000;

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
};

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
      headers['Authorization'] = `Bearer ${key}`;
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

proxyRouter.get('/keys/status', (_req, res) => {
  const status = {};
  for (const [provider, envName] of Object.entries(KEY_MAP)) {
    status[provider] = !!process.env[envName];
  }
  status.laozhang_image = !!process.env.LAOZHANG_IMAGE_API_KEY;
  status.laozhang_sora = !!process.env.LAOZHANG_SORA_API_KEY;
  res.json(status);
});

for (const provider of Object.keys(TARGETS)) {
  proxyRouter.all(`/${provider}/*`, async (req, res) => {
    const targetBase = TARGETS[provider];
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

    const authResult = injectAuth(provider, fwdHeaders, bodyText);
    if (!authResult.ok) {
      return res.status(400).json({
        error: `${KEY_MAP[provider]} não configurada no servidor.`,
      });
    }
    if (authResult.queryKey) {
      url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(authResult.queryKey);
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
        const upstream = await requestViaHttps(url, fetchOpts, LAOZHANG_UPSTREAM_TIMEOUT_MS);
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

function requestViaHttps(url, fetchOpts, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    let res = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      try { if (res) res.removeAllListeners(); } catch (_) {}
      fn();
    };
    let gotResponse = false;
    const req = https.request(url, {
      method: fetchOpts.method,
      headers: fetchOpts.headers,
    }, (incoming) => {
      gotResponse = true;
      res = incoming;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => finish(() => resolve({
        status: res.statusCode || 502,
        headers: res.headers || {},
        body: Buffer.concat(chunks),
      })));
      res.on('error', (err) => finish(() => {
        try { req.destroy(); } catch (_) {}
        reject(err);
      }));
    });
    deadline = setTimeout(() => finish(() => {
      try { req.destroy(); } catch (_) {}
      reject(new Error(`upstream timeout after ${timeoutMs}ms`));
    }), timeoutMs);
    const idleMs = Math.max(15000, Math.floor(timeoutMs / 3));
    req.setTimeout(idleMs, () => finish(() => {
      try { req.destroy(); } catch (_) {}
      reject(new Error(`upstream idle timeout after ${idleMs}ms`));
    }));
    req.on('error', (err) => finish(() => reject(err)));
    req.on('close', () => {
      if (!settled && !gotResponse) {
        finish(() => {
          try { req.destroy(); } catch (_) {}
          reject(new Error('upstream closed connection without response'));
        });
      }
    });
    if (fetchOpts.body && fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
      req.write(fetchOpts.body);
    }
    req.end();
  });
}
