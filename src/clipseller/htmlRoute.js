/**
 * Serve o clipseller-canvas-v31.html com patches injetados:
 *   1. Reescreve fetches diretos para APIs externas → /cs-proxy/*.
 *   2. Substitui chargeCreditsBackend por no-op (no standalone não há cobrança
 *      de créditos por feature — quem tem acesso, tem acesso ilimitado).
 *   3. Esconde elementos do header originais (créditos, voltar) que não fazem
 *      sentido no standalone.
 */
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireClipSellerAccess } from '../auth/middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTML_CANDIDATES = [
  resolve(__dirname, '../../public/clipseller-html/index.html'),
  resolve(__dirname, '../../public/clipseller-html/clipseller-canvas-v31.html'),
];
const HTML_PATH = HTML_CANDIDATES.find((p) => existsSync(p)) || HTML_CANDIDATES[0];

const BRIDGE = `
<script>
(function () {
  var CS_PROXY_MAP = [
    ['https://kieai.redpandaai.co/api', '/cs-proxy/kieupload'],
    ['https://api.kie.ai', '/cs-proxy/kie'],
    ['https://api.laozhang.ai', '/cs-proxy/laozhang'],
    ['https://queue.fal.run', '/cs-proxy/falqueue'],
    ['https://fal.run', '/cs-proxy/fal'],
    ['https://rest.alpha.fal.ai', '/cs-proxy/falcdn'],
    ['https://api.fashn.ai', '/cs-proxy/fashn'],
    ['https://generativelanguage.googleapis.com', '/cs-proxy/google'],
    ['https://api.anthropic.com', '/cs-proxy/anthropic'],
    ['https://api.openai.com', '/cs-proxy/openai'],
    ['https://api.replicate.com', '/cs-proxy/replicate'],
    ['https://api.freepik.com', '/cs-proxy/freepik'],
    ['https://api.elevenlabs.io', '/cs-proxy/elevenlabs'],
  ];
  function toCsProxyUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.charAt(0) === '/') return u;
    for (var i = 0; i < CS_PROXY_MAP.length; i++) {
      if (u.indexOf(CS_PROXY_MAP[i][0]) === 0) {
        return CS_PROXY_MAP[i][1] + u.slice(CS_PROXY_MAP[i][0].length);
      }
    }
    return u;
  }
  var _nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') return _nativeFetch(toCsProxyUrl(input), init);
    if (input && typeof input.url === 'string') {
      var proxied = toCsProxyUrl(input.url);
      if (proxied !== input.url) return _nativeFetch(proxied, init);
    }
    return _nativeFetch(input, init);
  };

  // ────────────────────────────────────────────────────────────────
  // Cobrança de créditos via backend standalone (/api/credits/charge)
  // ────────────────────────────────────────────────────────────────
  function csToken() {
    try { return (window.parent && window.parent.localStorage && window.parent.localStorage.getItem('cs_token')) || ''; }
    catch (_) { return ''; }
  }

  // Mapeia o featureKey legado do HTML para a tabela standalone (clipseller.novo.*)
  var FEATURE_MAP = {
    'clipseller.outros-3': 'clipseller.novo.img-basico',
    'clipseller.outros-5': 'clipseller.novo.img-basico',
    'clipseller.moda-3':   'clipseller.novo.moda-look',
    'clipseller.moda-5':   'clipseller.novo.moda-look',
    'clipseller.regen':    'clipseller.novo.regen',
    'clipseller.foto-inspirada': 'clipseller.novo.inspirada',
    'clipseller.edicao-livre':   'clipseller.novo.edicao-livre',
    'clipseller.trocar-modelo':  'clipseller.novo.provador',
    'clipseller.video-5s':       'clipseller.novo.vid-prod-5s',
    'clipseller.video-10s':      'clipseller.novo.vid-prod-10s',
    'clipseller.copy':           'clipseller.novo.titulo',
    'clipseller.criativos':      'clipseller.novo.img-basico',
  };
  function mapFeature(key) { return FEATURE_MAP[key] || key || 'clipseller.novo.img-basico'; }

  window.__cs_lastTxId = null;

  window.chargeCreditsBackend = async function (opts) {
    opts = opts || {};
    var featureKey = mapFeature(opts.featureKey || opts.feature);
    var token = csToken();
    if (!token) {
      alert('Sessão expirada. Faça login novamente.');
      try { window.top.location.href = '/'; } catch (_) {}
      return false;
    }
    try {
      var r = await fetch('/api/credits/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ featureKey: featureKey, description: opts.description || null }),
      });
      var data = {};
      try { data = await r.json(); } catch (_) {}
      if (r.status === 402) {
        alert('Créditos insuficientes (saldo: ' + (data.balance || 0) + ').\\n\\nCompre mais em "Meus créditos".');
        try { window.top.location.href = '/credits.html'; } catch (_) {}
        return false;
      }
      if (!r.ok) {
        alert(data.error || 'Não foi possível debitar créditos.');
        return false;
      }
      window.__cs_lastTxId = data.transactionId || null;
      if (typeof data.balance === 'number') {
        try { window.credits = data.balance; var c = document.getElementById('credn'); if (c) c.textContent = data.balance.toLocaleString('pt-BR'); } catch (_) {}
        try { window.parent.postMessage({ type: 'cs:balance', balance: data.balance }, '*'); } catch (_) {}
      } else if (data.admin) {
        try { var c = document.getElementById('credn'); if (c) c.textContent = '∞'; } catch (_) {}
      }
      return true;
    } catch (err) {
      console.error('[chargeCreditsBackend]', err);
      alert('Erro de conexão ao debitar créditos.');
      return false;
    }
  };

  window.__cs_refundTicket = async function () {
    var txId = window.__cs_lastTxId;
    if (!txId) return;
    var token = csToken();
    if (!token) return;
    try {
      await fetch('/api/credits/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ transactionId: txId }),
      });
      window.__cs_lastTxId = null;
    } catch (_) {}
  };

  // Atualiza o saldo no header do HTML a cada 20s e no DOMContentLoaded.
  async function refreshBalance() {
    var token = csToken();
    if (!token) return;
    try {
      var r = await fetch('/api/credits/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      var data = await r.json();
      window.credits = data.balance;
      var c = document.getElementById('credn');
      if (c) c.textContent = (data.balance || 0).toLocaleString('pt-BR');
      try { window.parent.postMessage({ type: 'cs:balance', balance: data.balance }, '*'); } catch (_) {}
    } catch (_) {}
  }
  document.addEventListener('DOMContentLoaded', refreshBalance);
  setInterval(refreshBalance, 20000);
})();
</script>
`;

function patchHtml(raw) {
  // Garante que o BRIDGE roda antes do código que define needCred/chargeCreditsBackend
  if (raw.includes('</body>')) {
    return raw.replace('</body>', BRIDGE + '</body>');
  }
  return raw + BRIDGE;
}

export const clipsellerHtmlRouter = Router();

clipsellerHtmlRouter.get('/', requireAuth, requireClipSellerAccess, async (_req, res) => {
  try {
    const raw = await readFile(HTML_PATH, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patchHtml(raw));
  } catch (err) {
    console.error('[clipseller-html]', err.message);
    res.status(500).send('Falha ao carregar o ClipSeller HTML.');
  }
});
