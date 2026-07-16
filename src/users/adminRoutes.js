import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  listUsers,
  publicUser,
  setUserAccess,
  setUserActive,
  generateActivationToken,
} from './service.js';
import { sendWelcomeEmail } from '../mail/ses.js';
import { adminAdjust, grantWelcomeCreditsIfEligible } from '../credits/service.js';
import { query } from '../db/pool.js';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/users', async (_req, res) => {
  const users = await listUsers();
  return res.json({ users: users.map(publicUser) });
});

router.post('/users', async (req, res) => {
  const { email, name, role = 'user', hasAccess = true, sendWelcome = true } = req.body || {};
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'E-mail já cadastrado' });
  let { user, activationToken, activationTokenExpires } = await createUser({
    email,
    name,
    role,
    hasAccess,
  });
  if (sendWelcome && activationToken) {
    try {
      await sendWelcomeEmail({
        to: user.email,
        name: user.name,
        token: activationToken,
        expiresAt: activationTokenExpires,
      });
    } catch (err) {
      console.error('[admin/users] sendWelcome falhou:', err.message);
    }
  }
  try {
    await grantWelcomeCreditsIfEligible(user.id);
    user = await findUserById(user.id);
  } catch (err) {
    console.error('[admin/users] welcome credits falhou:', err.message);
  }
  return res.status(201).json({ user: publicUser(user) });
});

router.post('/users/:id/credits', async (req, res) => {
  const { credits, reason } = req.body || {};
  const delta = Number(credits);
  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ error: 'Informe credits (número diferente de zero)' });
  }
  try {
    const out = await adminAdjust({
      userId: req.params.id,
      credits: delta,
      reason: reason || 'Ajuste manual pelo admin',
    });
    const user = await findUserById(req.params.id);
    return res.json({ ok: true, newBalance: out.newBalance, user: publicUser(user) });
  } catch (err) {
    if (err.message === 'user_not_found') return res.status(404).json({ error: 'Usuário não encontrado' });
    console.error('[admin/credits]', err.message);
    return res.status(500).json({ error: 'Falha ao ajustar créditos' });
  }
});

router.patch('/users/:id/access', async (req, res) => {
  const { hasAccess } = req.body || {};
  const user = await setUserAccess(req.params.id, hasAccess);
  return res.json({ user: publicUser(user) });
});

router.patch('/users/:id/active', async (req, res) => {
  const { isActive } = req.body || {};
  const user = await setUserActive(req.params.id, isActive);
  return res.json({ user: publicUser(user) });
});

/** Reenvia e-mail de boas-vindas (definir senha) para usuário sem password_hash. */
router.post('/users/:id/resend-welcome', async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.password_hash) {
    return res.status(400).json({
      error: 'Usuário já definiu senha. Use "Esqueci minha senha" se precisar resetar.',
    });
  }
  try {
    const reset = generateActivationToken();
    await query(
      'UPDATE users SET activation_token=$2, activation_token_expires=$3 WHERE id=$1',
      [user.id, reset.token, reset.expiresAt],
    );
    await sendWelcomeEmail({
      to: user.email,
      name: user.name,
      token: reset.token,
      expiresAt: reset.expiresAt,
    });
    console.log(`[admin] resend-welcome OK email=${user.email}`);
    return res.json({ ok: true, email: user.email });
  } catch (err) {
    console.error('[admin] resend-welcome falhou:', err.message);
    return res.status(503).json({ error: `Falha ao enviar e-mail: ${err.message}` });
  }
});

export default router;
