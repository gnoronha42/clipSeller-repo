import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'changeme-please';
const EXPIRES = process.env.JWT_EXPIRES_IN || '24h';

if (SECRET === 'changeme-please') {
  console.warn('[jwt] JWT_SECRET não definido — usando valor inseguro. Defina em produção.');
}

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}
