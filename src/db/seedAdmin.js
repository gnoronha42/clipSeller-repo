import 'dotenv/config';
import bcrypt from 'bcrypt';
import { pool } from './pool.js';

export async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.log('[seed-admin] ADMIN_EMAIL/ADMIN_PASSWORD vazios — pulando.');
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'SELECT id, role FROM users WHERE LOWER(email) = $1',
    [email],
  );
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO users (email, name, password_hash, role, is_active, has_access, must_change_password)
       VALUES ($1, $2, $3, 'admin', true, true, false)`,
      [email, name, hash],
    );
    console.log(`[seed-admin] admin criado: ${email}`);
  } else {
    await pool.query(
      `UPDATE users
         SET name = $2,
             password_hash = $3,
             role = 'admin',
             is_active = true,
             has_access = true
       WHERE id = $1`,
      [rows[0].id, name, hash],
    );
    console.log(`[seed-admin] admin atualizado: ${email}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureAdmin()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-admin]', err.message);
      process.exit(1);
    });
}
