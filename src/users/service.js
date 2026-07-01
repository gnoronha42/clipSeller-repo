import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';

const ACTIVATION_TTL_HOURS = 48;

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.is_active,
    hasAccess: u.has_access,
    mustChangePassword: u.must_change_password,
    credits: u.credits ?? 0,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

export async function findUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const { rows } = await query('SELECT * FROM users WHERE LOWER(email) = $1', [normalized]);
  return rows[0] || null;
}

export function generateActivationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 3600 * 1000);
  return { token, expiresAt };
}

export async function createUser({ email, name, role = 'user', hasAccess = true, password = null }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('E-mail obrigatório');
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;
  const { token, expiresAt } = password ? { token: null, expiresAt: null } : generateActivationToken();
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, role, is_active, has_access, must_change_password, activation_token, activation_token_expires)
     VALUES ($1, $2, $3, $4, true, $5, false, $6, $7)
     RETURNING *`,
    [normalized, name || '', passwordHash, role, hasAccess, token, expiresAt],
  );
  return { user: rows[0], activationToken: token, activationTokenExpires: expiresAt };
}

export async function verifyPassword(user, plain) {
  if (!user || !user.password_hash) return false;
  return bcrypt.compare(plain, user.password_hash);
}

export async function issueResetToken(userId) {
  const { token, expiresAt } = generateActivationToken();
  await query(
    'UPDATE users SET activation_token=$2, activation_token_expires=$3 WHERE id=$1',
    [userId, token, expiresAt],
  );
  return { token, expiresAt };
}

export async function consumeResetToken(email, token, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Senha deve ter pelo menos 6 caracteres');
  }
  const user = await findUserByEmail(email);
  if (!user || !user.activation_token || user.activation_token !== token) {
    throw new Error('Token inválido');
  }
  if (user.activation_token_expires && new Date(user.activation_token_expires) < new Date()) {
    throw new Error('Token expirado. Solicite um novo link.');
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const { rows } = await query(
    `UPDATE users
       SET password_hash=$2,
           activation_token=NULL,
           activation_token_expires=NULL,
           must_change_password=false,
           is_active=true
     WHERE id=$1
     RETURNING *`,
    [user.id, passwordHash],
  );
  return rows[0];
}

export async function changePassword(userId, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Senha deve ter pelo menos 6 caracteres');
  }
  const user = await findUserById(userId);
  if (!user) throw new Error('Usuário não encontrado');
  if (!user.must_change_password) {
    if (!currentPassword) throw new Error('Senha atual obrigatória');
    const ok = await bcrypt.compare(currentPassword, user.password_hash || '');
    if (!ok) throw new Error('Senha atual incorreta');
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query(
    'UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1',
    [userId, passwordHash],
  );
  return findUserById(userId);
}

export async function listUsers() {
  const { rows } = await query(
    `SELECT id, email, name, role, is_active, has_access, must_change_password, credits,
            created_at, updated_at
       FROM users
      ORDER BY created_at DESC`,
  );
  return rows;
}

export async function setUserAccess(id, hasAccess) {
  await query('UPDATE users SET has_access=$2 WHERE id=$1', [id, !!hasAccess]);
  return findUserById(id);
}

export async function setUserActive(id, isActive) {
  await query('UPDATE users SET is_active=$2 WHERE id=$1', [id, !!isActive]);
  return findUserById(id);
}
