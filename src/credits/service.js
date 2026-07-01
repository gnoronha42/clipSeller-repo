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

export async function getGenerationDashboard({ userId, isAdmin = false, days = 30 } = {}) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const scopeWhere = isAdmin ? '' : 'AND ct.user_id = $2';
  const params = isAdmin ? [safeDays] : [safeDays, userId];

  const [summary, byFeature, daily, topUsers] = await Promise.all([
    query(
      `SELECT
          COUNT(*)::int AS total_generations,
          COALESCE(SUM(ABS(ct.credits)), 0)::int AS credits_consumed,
          COUNT(DISTINCT ct.user_id)::int AS active_users,
          COALESCE(AVG(ABS(ct.credits)), 0)::numeric(10,2) AS avg_credits
        FROM credit_transactions ct
       WHERE ct.type = 'debit'
         AND ct.created_at >= now() - ($1::int * interval '1 day')
         ${scopeWhere}`,
      params,
    ),
    query(
      `SELECT
          COALESCE(ct.feature_key, 'unknown') AS feature_key,
          COALESCE(fc.label, ct.description, ct.feature_key, 'Geração') AS label,
          COALESCE(fc.category, 'outros') AS category,
          COUNT(*)::int AS generations,
          COALESCE(SUM(ABS(ct.credits)), 0)::int AS credits
        FROM credit_transactions ct
        LEFT JOIN feature_costs fc ON fc.feature_key = ct.feature_key
       WHERE ct.type = 'debit'
         AND ct.created_at >= now() - ($1::int * interval '1 day')
         ${scopeWhere}
       GROUP BY COALESCE(ct.feature_key, 'unknown'), COALESCE(fc.label, ct.description, ct.feature_key, 'Geração'), COALESCE(fc.category, 'outros')
       ORDER BY generations DESC, credits DESC
       LIMIT 12`,
      params,
    ),
    query(
      `SELECT
          to_char(gs.day::date, 'YYYY-MM-DD') AS date,
          COALESCE(counts.generations, 0)::int AS generations,
          COALESCE(counts.credits, 0)::int AS credits
        FROM generate_series(
          (current_date - ($1::int - 1) * interval '1 day')::date,
          current_date,
          interval '1 day'
        ) AS gs(day)
        LEFT JOIN (
          SELECT
              date_trunc('day', ct.created_at)::date AS day,
              COUNT(*)::int AS generations,
              COALESCE(SUM(ABS(ct.credits)), 0)::int AS credits
            FROM credit_transactions ct
           WHERE ct.type = 'debit'
             AND ct.created_at >= now() - ($1::int * interval '1 day')
             ${scopeWhere}
           GROUP BY date_trunc('day', ct.created_at)::date
        ) counts ON counts.day = gs.day::date
       ORDER BY gs.day`,
      params,
    ),
    isAdmin
      ? query(
          `SELECT
              u.id,
              u.name,
              u.email,
              COUNT(*)::int AS generations,
              COALESCE(SUM(ABS(ct.credits)), 0)::int AS credits
            FROM credit_transactions ct
            JOIN users u ON u.id = ct.user_id
           WHERE ct.type = 'debit'
             AND ct.created_at >= now() - ($1::int * interval '1 day')
           GROUP BY u.id, u.name, u.email
           ORDER BY generations DESC, credits DESC
           LIMIT 8`,
          [safeDays],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    days: safeDays,
    summary: summary.rows[0] || {
      total_generations: 0,
      credits_consumed: 0,
      active_users: 0,
      avg_credits: 0,
    },
    byFeature: byFeature.rows,
    daily: daily.rows,
    topUsers: topUsers.rows,
  };
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
