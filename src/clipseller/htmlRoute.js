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

  // No standalone não há cobrança de créditos por geração.
  window.chargeCreditsBackend = async function () { return true; };
  window.__cs_refundTicket = function () {};

  // Mantém o saldo "infinito" só visualmente.
  try { window.credits = 99999; } catch (_) {}
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var credn = document.getElementById('credn');
      if (credn) credn.textContent = '∞';
    } catch (_) {}
  });
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
