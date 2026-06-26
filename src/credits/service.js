import { pool, query } from '../db/pool.js';

/** Preço do crédito avulso em centavos (R$ 0,16). */
export const AVULSO_PRICE_CENTS = 16;

export async function getBalance(userId) {
  const { rows } = await query('SELECT credits FROM users WHERE id = $1', [userId]);
  return rows[0]?.credits ?? 0;
}

export async function listPackages() {
  const { rows } = await query(
    'SELECT id, slug, name, credits, price_cents, sort_order FROM credit_packages WHERE active = true ORDER BY sort_order, price_cents',
  );
  return rows;
}

export async function getPackageBySlug(slug) {
  const { rows } = await query(
    'SELECT * FROM credit_packages WHERE slug = $1 AND active = true',
    [slug],
  );
  return rows[0] || null;
}

export async function listFeatureCosts() {
  const { rows } = await query(
    'SELECT feature_key, label, cost_credits, category FROM feature_costs ORDER BY category, cost_credits',
  );
  return rows;
}

export async function getFeatureCost(featureKey) {
  const { rows } = await query(
    'SELECT cost_credits, label FROM feature_costs WHERE feature_key = $1',
    [featureKey],
  );
  return rows[0] || null;
}

export async function listTransactions(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, type, credits, balance_after, feature_key, description,
            payment_provider, payment_id, created_at
       FROM credit_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/**
 * Debita créditos do usuário de forma atômica. Retorna o saldo após ou lança
 * Error('insufficient_credits') se não der.
 */
export async function debit({ userId, featureKey, description = null, metadata = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cost = await client.query(
      'SELECT cost_credits, label FROM feature_costs WHERE feature_key = $1',
      [featureKey],
    );
    if (!cost.rows[0]) {
      throw new Error('unknown_feature');
    }
    const costCredits = cost.rows[0].cost_credits;
    const label = cost.rows[0].label;

    const upd = await client.query(
      `UPDATE users
          SET credits = credits - $2
        WHERE id = $1 AND credits >= $2
        RETURNING credits`,
      [userId, costCredits],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error('insufficient_credits');
    }
    const newBalance = upd.rows[0].credits;

    const tx = await client.query(
      `INSERT INTO credit_transactions
         (user_id, type, credits, balance_after, feature_key, description, metadata)
       VALUES ($1, 'debit', $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, -costCredits, newBalance, featureKey, description ?? label, metadata ? JSON.stringify(metadata) : null],
    );
    await client.query('COMMIT');
    return { transactionId: tx.rows[0].id, costCredits, newBalance };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** Reembolsa uma operação anterior (cria transação 'refund'). */
export async function refund({ userId, transactionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query(
      `SELECT * FROM credit_transactions
        WHERE id = $1 AND user_id = $2 AND type = 'debit'`,
      [transactionId, userId],
    );
    if (!tx.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error('debit_not_found');
    }
    const already = await client.query(
      `SELECT 1 FROM credit_transactions
        WHERE user_id = $1 AND type = 'refund' AND metadata @> $2::jsonb`,
      [userId, JSON.stringify({ refundOf: transactionId })],
    );
    if (already.rowCount > 0) {
      await client.query('ROLLBACK');
      return { alreadyRefunded: true };
    }
    const amount = Math.abs(tx.rows[0].credits);
    const upd = await client.query(
      'UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits',
      [userId, amount],
    );
    const newBalance = upd.rows[0].credits;
    await client.query(
      `INSERT INTO credit_transactions
         (user_id, type, credits, balance_after, feature_key, description, metadata)
       VALUES ($1, 'refund', $2, $3, $4, $5, $6)`,
      [userId, amount, newBalance, tx.rows[0].feature_key, `Reembolso: ${tx.rows[0].description || ''}`, JSON.stringify({ refundOf: transactionId })],
    );
    await client.query('COMMIT');
    return { newBalance, refundedCredits: amount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Credita o usuário após pagamento aprovado (idempotente via payment_id).
 */
export async function creditFromPayment({ userId, credits, paymentId, provider = 'mercadopago', metadata = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, balance_after FROM credit_transactions
        WHERE payment_provider = $1 AND payment_id = $2`,
      [provider, paymentId],
    );
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return { alreadyProcessed: true, newBalance: existing.rows[0].balance_after };
    }
    const upd = await client.query(
      'UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits',
      [userId, credits],
    );
    if (upd.rowCount === 0) {
      throw new Error('user_not_found');
    }
    const newBalance = upd.rows[0].credits;
    await client.query(
      `INSERT INTO credit_transactions
         (user_id, type, credits, balance_after, feature_key, description, payment_provider, payment_id, metadata)
       VALUES ($1, 'purchase', $2, $3, NULL, $4, $5, $6, $7)`,
      [
        userId,
        credits,
        newBalance,
        `Compra de ${credits.toLocaleString('pt-BR')} créditos`,
        provider,
        paymentId,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    await client.query('COMMIT');
    return { newBalance, creditsAdded: credits };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** Ajuste manual de saldo (admin). */
export async function adminAdjust({ userId, credits, reason = 'Ajuste manual' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE users SET credits = credits + $2 WHERE id = $1 RETURNING credits',
      [userId, credits],
    );
    if (upd.rowCount === 0) throw new Error('user_not_found');
    const newBalance = upd.rows[0].credits;
    await client.query(
      `INSERT INTO credit_transactions
         (user_id, type, credits, balance_after, description)
       VALUES ($1, 'adjust', $2, $3, $4)`,
      [userId, credits, newBalance, reason],
    );
    await client.query('COMMIT');
    return { newBalance };
  } finally {
    client.release();
  }
}
