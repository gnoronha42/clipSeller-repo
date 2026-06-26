import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePassword,
  consumeResetToken,
  findUserByEmail,
  issueResetToken,
  publicUser,
  verifyPassword,
} from '../users/service.js';
import { signToken } from './jwt.js';
import { requireAuth } from './middleware.js';
import { sendPasswordResetEmail, sendWelcomeEmail } from '../mail/ses.js';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });
const forgotLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true });

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha' });
  const user = await findUserByEmail(email);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  }
  if (!user.password_hash) {
    return res.status(401).json({
      error: 'Conta sem senha definida. Clique em "Esqueci minha senha" para receber o link.',
    });
  }
  const ok = await verifyPassword(user, password);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha inválidos' });
  const token = signToken({ sub: user.id, email: user.email, role: user.role });
  return res.json({
    accessToken: token,
    mustChangePassword: user.must_change_password,
    user: publicUser(user),
  });
});

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Informe o e-mail' });
  const user = await findUserByEmail(email);
  // Resposta neutra para evitar enumeração
  const neutral = {
    message:
      'Se o e-mail estiver cadastrado, você receberá um link para definir uma nova senha em alguns minutos.',
  };
  if (!user) return res.json(neutral);
  try {
    const { token, expiresAt } = await issueResetToken(user.id);
    if (user.password_hash) {
      await sendPasswordResetEmail({ to: user.email, name: user.name, token, expiresAt });
    } else {
      await sendWelcomeEmail({ to: user.email, name: user.name, token, expiresAt });
    }
  } catch (err) {
    console.error('[forgot-password]', err.message);
  }
  return res.json(neutral);
});

router.post('/set-password', forgotLimiter, async (req, res) => {
  const { email, token, password } = req.body || {};
  if (!email || !token || !password) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }
  try {
    const user = await consumeResetToken(email, token, password);
    const accessToken = signToken({ sub: user.id, email: user.email, role: user.role });
    return res.json({ accessToken, user: publicUser(user), mustChangePassword: false });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: 'newPassword obrigatório' });
  try {
    const user = await changePassword(req.user.id, currentPassword, newPassword);
    const accessToken = signToken({ sub: user.id, email: user.email, role: user.role });
    return res.json({ accessToken, user: publicUser(user), mustChangePassword: false });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/logout', requireAuth, (_req, res) => res.json({ ok: true }));

export default router;
