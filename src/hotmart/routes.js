import { Router } from 'express';
import { query } from '../db/pool.js';
import {
  createUser,
  findUserByEmail,
  generateActivationToken,
  publicUser,
} from '../users/service.js';
import { sendWelcomeEmail } from '../mail/ses.js';
import { grantWelcomeCreditsIfEligible } from '../credits/service.js';

const router = Router();

function configuredProductIds() {
  return String(process.env.HOTMART_CLIPSELLER_PRODUCT_IDS || '7932619')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateHottok(req) {
  const expected = (process.env.HOTMART_WEBHOOK_HOTTOK || '').trim();
  if (!expected) return true;
  const received = String(
    req.headers.hottok ||
      req.headers['x-hotmart-hottok'] ||
      req.body?.hottok ||
      req.query?.hottok ||
      '',
  ).trim();
  return received === expected;
}

function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split('.')) {
      if (cur == null || typeof cur !== 'object') { cur = undefined; break; }
      cur = cur[key];
    }
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') return cur;
  }
  return undefined;
}

function normalizeHotmart(body) {
  const record = body && typeof body === 'object' ? body : {};
  const event = String(pick(record, ['event', 'event_type', 'status', 'cms_event']) || '').toUpperCase();
  const productId = String(pick(record, [
    'data.product.id',
    'data.product.productId',
    'data.product_id',
    'data.productId',
    'product.id',
    'product_id',
    'productId',
    'prod',
    'prod_id',
  ]) || '').trim();
  const buyerEmail = String(pick(record, [
    'data.buyer.email',
    'data.customer.email',
    'data.user.email',
    'buyer.email',
    'customer.email',
    'email',
    'buyer_email',
  ]) || '').trim().toLowerCase();
  const buyerName = String(pick(record, [
    'data.buyer.name',
    'data.customer.name',
    'data.user.name',
    'buyer.name',
    'customer.name',
    'name',
    'buyer_name',
  ]) || '').trim();
  const transactionId = String(pick(record, [
    'data.purchase.transaction',
    'data.purchase.transaction_id',
    'data.transaction',
    'transaction',
    'transaction_id',
    'id',
  ]) || '').trim();
  const subscriberCode = String(pick(record, [
    'data.subscription.subscriber.code',
    'data.subscription.subscriber_code',
    'data.subscriberCode',
    'subscriber_code',
    'subscriberCode',
  ]) || '').trim();
  const status = String(pick(record, [
    'data.purchase.status',
    'data.subscription.status',
    'data.status',
    'purchase.status',
    'subscription.status',
    'status',
  ]) || '').toUpperCase();
  return { record, event, productId, buyerEmail, buyerName, transactionId, subscriberCode, status };
}

function shouldGrant(event, status) {
  const grants = new Set([
    'PURCHASE_APPROVED',
    'PURCHASE_COMPLETE',
    'SUBSCRIPTION_APPROVED',
    'SUBSCRIPTION_RENEWAL',
  ]);
  if (!event && ['APPROVED', 'COMPLETE', 'ACTIVE'].includes(status)) return true;
  return grants.has(event) && (!status || ['APPROVED', 'COMPLETE', 'ACTIVE'].includes(status));
}

function shouldRevoke(event, status) {
  const revokes = new Set([
    'PURCHASE_REFUNDED',
    'PURCHASE_CANCELED',
    'PURCHASE_CANCELLED',
    'PURCHASE_CHARGEBACK',
    'PURCHASE_EXPIRED',
    'SUBSCRIPTION_CANCELLATION',
    'SUBSCRIPTION_CANCELED',
    'SUBSCRIPTION_CANCELLED',
  ]);
  return revokes.has(event) || ['REFUNDED', 'CANCELED', 'CANCELLED', 'CHARGEBACK', 'EXPIRED', 'OVERDUE'].includes(status);
}

async function consumeEvent(key, meta) {
  try {
    await query(
      `INSERT INTO hotmart_webhook_events
         (idempotency_key, event, product_id, buyer_email, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [key, meta.event, meta.productId, meta.buyerEmail, JSON.stringify(meta.payload || {})],
    );
    return true;
  } catch (err) {
    if (err && err.code === '23505') return false;
    throw err;
  }
}

async function eventAlreadyProcessed(key) {
  const { rows } = await query(
    'SELECT 1 FROM hotmart_webhook_events WHERE idempotency_key = $1 LIMIT 1',
    [key],
  );
  return rows.length > 0;
}

/**
 * Garante token de ativação + envia e-mail de boas-vindas.
 * Falha de SES propaga — o caller NÃO deve marcar o evento como processado
 * até o e-mail sair (Hotmart reenvia o webhook).
 */
async function ensureWelcomeEmail(user) {
  let activationToken = null;
  let activationTokenExpires = null;

  if (!user.password_hash) {
    const reset = generateActivationToken();
    activationToken = reset.token;
    activationTokenExpires = reset.expiresAt;
    await query(
      'UPDATE users SET activation_token=$2, activation_token_expires=$3 WHERE id=$1',
      [user.id, activationToken, activationTokenExpires],
    );
  }

  if (!activationToken) {
    return { passwordEmailSent: false, reason: 'user_already_has_password' };
  }

  await sendWelcomeEmail({
    to: user.email,
    name: user.name,
    token: activationToken,
    expiresAt: activationTokenExpires,
  });
  console.log(`[hotmart] welcome email SENT to=${user.email}`);
  return { passwordEmailSent: true };
}

async function grantClipSellerAccess({ email, name, subscriberCode }) {
  let user = await findUserByEmail(email);
  let isNew = false;
  let passwordEmailSent = false;

  if (!user) {
    const created = await createUser({ email, name, role: 'user', hasAccess: true });
    user = created.user;
    isNew = true;
    if (subscriberCode) {
      await query(
        'UPDATE users SET hotmart_subscriber_code=$2 WHERE id=$1',
        [user.id, subscriberCode],
      );
      user = await findUserByEmail(email);
    }
    if (!created.activationToken) {
      throw new Error('activation_token_missing_for_new_user');
    }
    await sendWelcomeEmail({
      to: user.email,
      name: user.name,
      token: created.activationToken,
      expiresAt: created.activationTokenExpires,
    });
    console.log(`[hotmart] welcome email SENT to=${user.email} (new user)`);
    passwordEmailSent = true;
  } else {
    await query(
      `UPDATE users
          SET name = COALESCE(NULLIF($2, ''), name),
              role = CASE WHEN role = 'admin' THEN role ELSE 'user' END,
              is_active = true,
              has_access = true,
              hotmart_subscriber_code = COALESCE(NULLIF($3, ''), hotmart_subscriber_code)
        WHERE id = $1`,
      [user.id, name || '', subscriberCode || ''],
    );
    user = await findUserByEmail(email);

    if (!user.password_hash) {
      const emailOut = await ensureWelcomeEmail(user);
      passwordEmailSent = Boolean(emailOut.passwordEmailSent);
      user = await findUserByEmail(email);
    } else {
      console.log(`[hotmart] skip welcome email — user already has password email=${email}`);
    }
  }

  let welcomeCredits = null;
  try {
    welcomeCredits = await grantWelcomeCreditsIfEligible(user.id);
    if (welcomeCredits?.granted) user = await findUserByEmail(email);
  } catch (err) {
    console.error('[hotmart] welcome credits falhou:', err.message);
  }

  return {
    user,
    isNew,
    passwordEmailSent,
    welcomeCredits,
  };
}

async function revokeClipSellerAccess({ email, subscriberCode }) {
  if (email) {
    await query(
      `UPDATE users SET has_access=false WHERE LOWER(email)=$1 AND role <> 'admin'`,
      [email.toLowerCase()],
    );
  } else if (subscriberCode) {
    await query(
      `UPDATE users SET has_access=false WHERE hotmart_subscriber_code=$1 AND role <> 'admin'`,
      [subscriberCode],
    );
  }
}

/**
 * Se o evento já foi consumido mas o comprador ainda não tem senha,
 * reenvia o e-mail (recupera falha SES após consume antigo).
 */
async function retryWelcomeIfPending(email) {
  if (!email) return { passwordEmailSent: false };
  const user = await findUserByEmail(email);
  if (!user) return { passwordEmailSent: false, reason: 'user_missing' };
  if (user.password_hash) return { passwordEmailSent: false, reason: 'user_already_has_password' };
  const out = await ensureWelcomeEmail(user);
  return out;
}

router.post('/hotmart', async (req, res) => {
  const receivedAt = new Date().toISOString();
  console.log(`[hotmart] INCOMING at=${receivedAt} ip=${req.ip} ua=${req.headers['user-agent'] || '-'}`);

  if (!validateHottok(req)) {
    console.warn('[hotmart] hottok inválido');
    return res.status(401).json({ ok: false, reason: 'invalid_hottok' });
  }

  const data = normalizeHotmart(req.body);
  console.log(
    `[hotmart] parsed event=${data.event || 'n/a'} status=${data.status || 'n/a'} `
    + `product=${data.productId || 'n/a'} email=${data.buyerEmail || 'n/a'} `
    + `tx=${data.transactionId || 'n/a'}`,
  );

  const allowed = configuredProductIds();
  if (!allowed.includes(data.productId)) {
    console.log(`[hotmart] productId=${data.productId || 'n/a'} ignorado (allowed=${allowed.join(',')})`);
    return res.json({ ok: true, skipped: true, reason: 'product_not_allowed', productId: data.productId });
  }

  const grant = shouldGrant(data.event, data.status);
  const revoke = shouldRevoke(data.event, data.status);
  if (!grant && !revoke) {
    console.log(`[hotmart] event ignored event=${data.event} status=${data.status}`);
    return res.json({ ok: true, skipped: true, reason: 'event_ignored', event: data.event, status: data.status });
  }
  if (!data.buyerEmail && !data.subscriberCode) {
    console.warn('[hotmart] missing identity');
    return res.json({ ok: true, skipped: true, reason: 'missing_identity' });
  }

  const key = `hotmart:${data.event || data.status}:${data.transactionId || data.subscriberCode || data.buyerEmail}:${data.productId}`;

  // Idempotência: se já processamos, ainda tenta reenviar welcome se a conta ficou sem senha
  // (protege contra o bug antigo: consume antes do SES falhar).
  if (await eventAlreadyProcessed(key)) {
    console.log(`[hotmart] duplicate key=${key}`);
    if (grant && data.buyerEmail) {
      try {
        const retry = await retryWelcomeIfPending(data.buyerEmail);
        if (retry.passwordEmailSent) {
          return res.json({
            ok: true,
            action: 'grant_email_retry',
            passwordEmailSent: true,
            productId: data.productId,
          });
        }
      } catch (err) {
        console.error('[hotmart] retry welcome falhou:', err.message);
        return res.status(503).json({ ok: false, reason: 'email_send_failed', error: err.message });
      }
    }
    return res.json({ ok: true, skipped: true, reason: 'duplicate' });
  }

  try {
    if (grant) {
      const out = await grantClipSellerAccess({
        email: data.buyerEmail,
        name: data.buyerName,
        subscriberCode: data.subscriberCode,
      });
      // Só marca como processado DEPOIS do grant + e-mail (se aplicável)
      await consumeEvent(key, {
        event: data.event || data.status,
        productId: data.productId,
        buyerEmail: data.buyerEmail,
        payload: data.record,
      });
      console.log(
        `[hotmart] GRANT product=${data.productId} email=${data.buyerEmail} `
        + `new=${out.isNew} emailSent=${out.passwordEmailSent}`,
      );
      return res.json({
        ok: true,
        action: 'grant',
        productId: data.productId,
        isNew: out.isNew,
        passwordEmailSent: out.passwordEmailSent,
        user: publicUser(out.user),
      });
    }

    await revokeClipSellerAccess({ email: data.buyerEmail, subscriberCode: data.subscriberCode });
    await consumeEvent(key, {
      event: data.event || data.status,
      productId: data.productId,
      buyerEmail: data.buyerEmail,
      payload: data.record,
    });
    console.log(`[hotmart] REVOKE product=${data.productId} email=${data.buyerEmail || data.subscriberCode}`);
    return res.json({ ok: true, action: 'revoke', productId: data.productId });
  } catch (err) {
    console.error('[hotmart] PROCESSING FAILED — evento NÃO consumido (Hotmart pode reenviar):', err.message);
    return res.status(503).json({
      ok: false,
      reason: 'processing_failed',
      error: err.message,
      retryable: true,
    });
  }
});

export default router;
