import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import authRoutes from './src/auth/routes.js';
import adminRoutes from './src/users/adminRoutes.js';
import creditsRoutes, { webhookRouter as creditsWebhookRouter } from './src/credits/routes.js';
import hotmartRoutes from './src/hotmart/routes.js';
import { proxyRouter } from './src/proxy/routes.js';
import { mediaRouter } from './src/media/routes.js';
import { clipsellerHtmlRouter } from './src/clipseller/htmlRoute.js';
import { runMigrations } from './src/db/migrate.js';
import { ensureAdmin } from './src/db/seedAdmin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(cookieParser());

// /cs-proxy precisa de raw body — registra ANTES do express.json
app.use('/cs-proxy', proxyRouter);
// /clipseller-html: roteador de HTML autenticado — usa apenas GET, sem body parser
app.use('/clipseller-html', clipsellerHtmlRouter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/media', mediaRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'clipseller', ts: Date.now() }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/credits', creditsRoutes);
// Webhook MP é público: /api/credits/webhook (montado SEM auth)
app.use('/api/credits', creditsWebhookRouter);
// Webhook Hotmart standalone: /api/webhooks/hotmart
app.use('/api/webhooks', hotmartRoutes);

// Estáticos: imagens, login, set-password, forgot
app.use(express.static(resolve(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// Fallback SPA simples: rotas client-side sem extensão caem no index.html
app.get(/^\/(?!api|cs-proxy|clipseller-html|img|assets|set-password|forgot|login|credits).*$/, (_req, res) => {
  res.sendFile(resolve(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Erro interno' });
});

async function boot() {
  try {
    await runMigrations();
    await ensureAdmin();
  } catch (err) {
    console.error('[boot]', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[clipseller] ouvindo em :${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  });
}

boot();
