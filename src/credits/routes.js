import { Router } from 'express';
import { requireAuth, requireClipSellerAccess } from '../auth/middleware.js';
import {
  AVULSO_PRICE_CENTS,
  creditFromPayment,
  debit,
  getBalance,
  getGenerationDashboard,
  getPackageBySlug,
  listFeatureCosts,
  listPackages,
  listTransactions,
  refund,
} from './service.js';
import {
  createPreference,
  getPayment,
  isConfigured,
  isSandbox,
  verifyWebhookSignature,
} from './mp.js';
import { findUserById } from '../users/service.js';

const router = Router();

// ──────────────────────────────────────────────────────────────────────
// Endpoints autenticados
// ──────────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req, res) => {
  const [balance, transactions] = await Promise.all([
    getBalance(req.user.id),
    listTransactions(req.user.id, { limit: 30 }),
  ]);
  res.json({
    balance,
    transactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      credits: t.credits,
      balanceAfter: t.balance_after,
      featureKey: t.feature_key,
      description: t.description,
      paymentProvider: t.payment_provider,
      paymentId: t.payment_id,
      createdAt: t.created_at,
    })),
  });
});

router.get('/packages', requireAuth, async (_req, res) => {
  const packages = await listPackages();
  res.json({
    packages: packages.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      credits: p.credits,
      priceCents: p.price_cents,
      pricePerCredit: p.price_cents / p.credits,
    })),
    avulsoPriceCents: AVULSO_PRICE_CENTS,
    mp: { configured: isConfigured(), sandbox: isSandbox() },
  });
});

router.get('/feature-costs', requireAuth, async (_req, res) => {
  const costs = await listFeatureCosts();
  res.json({ costs });
});

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const isAdmin = req.user.role === 'admin';
    const data = await getGenerationDashboard({
      userId: req.user.id,
      isAdmin,
      days,
    });
    res.json({
      scope: isAdmin ? 'global' : 'user',
      ...data,
    });
  } catch (err) {
    console.error('[credits/dashboard]', err.message);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

/**
 * Cria a preferência de pagamento no MP e retorna a URL do checkout.
 * Body: { packageSlug?: string, customCredits?: number }
 */
router.post('/checkout', requireAuth, async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Mercado Pago não configurado no servidor.' });
  }
  const { packageSlug, customCredits } = req.body || {};
  let credits = 0;
  let priceCents = 0;
  let itemId = '';
  let itemTitle = '';

  if (packageSlug) {
    const pkg = await getPackageBySlug(packageSlug);
    if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
    credits = pkg.credits;
    priceCents = pkg.price_cents;
    itemId = pkg.slug;
    itemTitle = pkg.name;
  } else if (Number.isFinite(Number(customCredits)) && Number(customCredits) > 0) {
    credits = Math.floor(Number(customCredits));
    if (credits < 100) return res.status(400).json({ error: 'Mínimo de 100 créditos avulsos.' });
    priceCents = credits * AVULSO_PRICE_CENTS;
    itemId = 'avulso';
    itemTitle = `${credits.toLocaleString('pt-BR')} créditos avulsos`;
  } else {
    return res.status(400).json({ error: 'Informe packageSlug ou customCredits.' });
  }

  // external_reference codifica a origem (userId|itemId|credits) para o webhook.
  // Inclui timestamp para evitar colisão de X-Idempotency-Key entre compras repetidas.
  const externalReference = `${req.user.id}|${itemId}|${credits}|${Date.now()}`;

  try {
    const pref = await createPreference({
      externalReference,
      itemId,
      itemTitle,
      unitPrice: priceCents / 100,
      payerEmail: req.user.email,
      metadata: { userId: req.user.id, credits, priceCents, itemId },
    });
    return res.json({
      checkoutUrl: isSandbox() ? pref.sandbox_init_point : pref.init_point,
      preferenceId: pref.id,
      credits,
      priceCents,
    });
  } catch (err) {
    console.error('[credits/checkout]', err.message);
    return res.status(502).json({ error: `Falha ao criar preferência: ${err.message}` });
  }
});

/**
 * Débito a partir do iframe ClipSeller. Validações:
 *   - usuário autenticado
 *   - admin não consome créditos (saldo ilimitado)
 *   - feature_key existe na tabela feature_costs
 */
router.post('/charge', requireAuth, requireClipSellerAccess, async (req, res) => {
  const { featureKey, description = null, metadata = null } = req.body || {};
  if (!featureKey) return res.status(400).json({ error: 'featureKey obrigatório' });

  if (req.user.role === 'admin') {
    return res.json({ ok: true, admin: true, balance: null, charged: 0 });
  }

  try {
    const out = await debit({ userId: req.user.id, featureKey, description, metadata });
    return res.json({
      ok: true,
      transactionId: out.transactionId,
      charged: out.costCredits,
      balance: out.newBalance,
    });
  } catch (err) {
    if (err.message === 'insufficient_credits') {
      const balance = await getBalance(req.user.id);
      return res.status(402).json({ error: 'Créditos insuficientes', balance });
    }
    if (err.message === 'unknown_feature') {
      return res.status(400).json({ error: `Feature desconhecida: ${featureKey}` });
    }
    console.error('[credits/charge]', err.message);
    return res.status(500).json({ error: 'Erro ao debitar créditos' });
  }
});

router.post('/refund', requireAuth, async (req, res) => {
  const { transactionId } = req.body || {};
  if (!transactionId) return res.status(400).json({ error: 'transactionId obrigatório' });
  if (req.user.role === 'admin') {
    return res.json({ ok: true, admin: true });
  }
  try {
    const out = await refund({ userId: req.user.id, transactionId });
    return res.json({ ok: true, ...out });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Webhook MP (público, sem auth)
// ──────────────────────────────────────────────────────────────────────

export const webhookRouter = Router();

webhookRouter.post('/webhook', async (req, res) => {
  // O MP envia data.id na query string E no body { data: { id } }.
  const dataId = (req.query?.['data.id'] || req.body?.data?.id || '').toString();
  const xSignature = req.headers['x-signature'] || '';
  const xRequestId = req.headers['x-request-id'] || '';

  const valid = verifyWebhookSignature({
    xSignature,
    xRequestId,
    dataId,
  });
  if (!valid) {
    console.warn('[mp-webhook] assinatura inválida — dataId=' + dataId);
    return res.status(200).json({ ok: false, reason: 'invalid_signature' });
  }

  if (!dataId) return res.status(200).json({ ok: false, reason: 'missing_payment_id' });

  const action = req.body?.action || req.body?.type || '';
  if (action && !['payment.created', 'payment.updated', 'payment'].some((a) => action.startsWith(a))) {
    return res.status(200).json({ ok: true, reason: 'ignored_action', action });
  }

  try {
    const payment = await getPayment(dataId);
    if (payment.status !== 'approved') {
      console.log(`[mp-webhook] paymentId=${dataId} status=${payment.status} — ignorado`);
      return res.json({ ok: true, status: payment.status });
    }
    const parts = String(payment.external_reference || '').split('|');
    const userId = parts[0];
    const itemId = parts[1] ?? '';
    const credits = parseInt(parts[2] ?? '0', 10);
    if (!userId || !credits) {
      console.error(`[mp-webhook] external_reference inválido: ${payment.external_reference}`);
      return res.json({ ok: false, reason: 'invalid_external_reference' });
    }
    const user = await findUserById(userId);
    if (!user) return res.json({ ok: false, reason: 'user_not_found' });

    const out = await creditFromPayment({
      userId,
      credits,
      paymentId: String(dataId),
      provider: 'mercadopago',
      metadata: {
        itemId,
        externalReference: payment.external_reference,
        transactionAmount: payment.transaction_amount,
      },
    });
    console.log(
      `[mp-webhook] paymentId=${dataId} user=${userId} +${credits} cr → saldo=${out.newBalance}` +
        (out.alreadyProcessed ? ' (já processado)' : ''),
    );
    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error(`[mp-webhook] paymentId=${dataId}: ${err.message}`);
    // 200 para evitar retry infinito do MP em erros de aplicação
    return res.status(200).json({ ok: false, error: err.message });
  }
});

export default router;
