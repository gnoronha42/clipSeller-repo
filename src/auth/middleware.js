import { verifyToken } from './jwt.js';
import { findUserById } from '../users/service.js';

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  if (req.cookies && req.cookies.cs_token) return req.cookies.cs_token;
  return null;
}

export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = verifyToken(token);
    const user = await findUserById(payload.sub);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Sessão inválida' });
    }
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores' });
  }
  next();
}

export function requireClipSellerAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
  if (req.user.role === 'admin' || req.user.has_access) return next();
  return res.status(403).json({ error: 'Sem acesso ao ClipSeller' });
}
