import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import {
  createUser,
  findUserByEmail,
  listUsers,
  publicUser,
  setUserAccess,
  setUserActive,
} from './service.js';
import { sendWelcomeEmail } from '../mail/ses.js';

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
  const { user, activationToken, activationTokenExpires } = await createUser({
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
  return res.status(201).json({ user: publicUser(user) });
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

export default router;
