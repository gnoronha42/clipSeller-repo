import crypto from 'node:crypto';

const BASE = 'https://api.mercadopago.com';

function accessToken() {
  return (process.env.MP_ACCESS_TOKEN || '').trim();
}

export function isConfigured() {
  return Boolean(accessToken());
}

export function isSandbox() {
  return String(process.env.MP_SANDBOX || 'false').toLowerCase() === 'true';
}

export function publicUrl() {
  return (process.env.PUBLIC_URL || 'https://clipseller.com.br').replace(/\/$/, '');
}

export async function createPreference({
  externalReference,
  itemId,
  itemTitle,
  unitPrice,
  payerEmail,
  metadata,
}) {
  const token = accessToken();
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');

  const app = publicUrl();
  const body = {
    external_reference: externalReference,
    items: [
      {
        id: itemId,
        title: itemTitle,
        quantity: 1,
        unit_price: unitPrice, // BRL (não centavos)
        currency_id: 'BRL',
      },
    ],
    ...(payerEmail ? { payer: { email: payerEmail } } : {}),
    back_urls: {
      success: `${app}/credits.html?payment=success`,
      failure: `${app}/credits.html?payment=failure`,
      pending: `${app}/credits.html?payment=pending`,
    },
    auto_return: 'approved',
    notification_url: `${app}/api/credits/webhook`,
    statement_descriptor: 'CLIPSELLER',
    ...(metadata ? { metadata } : {}),
    expires: true,
    expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const res = await fetch(`${BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Idempotency-Key': externalReference,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MercadoPago ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getPayment(paymentId) {
  const token = accessToken();
  const res = await fetch(`${BASE}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MercadoPago getPayment ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Verifica a assinatura do webhook conforme spec MP.
 * Header esperado: x-signature: "ts=...,v1=..."
 *                  x-request-id
 * Message: id:<dataId>;request-id:<xRequestId>;ts:<ts>
 */
export function verifyWebhookSignature({ xSignature, xRequestId, dataId }) {
  const secret = process.env.MP_WEBHOOK_SECRET || '';
  if (!secret) return true; // modo permissivo quando não configurado
  try {
    const parts = String(xSignature || '').split(',');
    const tsPart = parts.find((p) => p.trim().startsWith('ts='));
    const v1Part = parts.find((p) => p.trim().startsWith('v1='));
    if (!tsPart || !v1Part) return false;
    const ts = tsPart.split('=')[1];
    const received = v1Part.split('=')[1];
    const message = `id:${dataId};request-id:${xRequestId};ts:${ts}`;
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch (_) {
    return false;
  }
}
