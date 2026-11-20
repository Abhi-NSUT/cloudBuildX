import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';

export type Role = 'USER' | 'ADMIN';

export interface AuthUser {
  id: string;
  role: Role;
}

// Extend the Express Request type to include our user object
export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_SUPER_SECRET_KEY';

// Verifies a raw JWT (without the "Bearer " prefix). Throws on invalid/expired tokens.
// Tokens issued before roles existed have no role claim, so they default to USER.
export const verifyToken = (token: string): AuthUser => {
  const decoded = jwt.verify(token, JWT_SECRET) as { id: string; role?: Role };
  return { id: decoded.id, role: decoded.role === 'ADMIN' ? 'ADMIN' : 'USER' };
};

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  try {
    req.user = verifyToken(authHeader.slice('Bearer '.length));
    next();
  } catch {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
};

// Must run after requireAuth. Allows the request only if the user has one of the given roles.
export const requireRole =
  (...roles: Role[]) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };

// Ownership rule used by every build/repository lookup: owners see their own
// resources, admins see everything. Throws so routes stay linear.
export const assertOwnerOrAdmin = (user: AuthUser | undefined, ownerId: string) => {
  if (!user) throw new AppError(401, 'Authentication required');
  if (user.role !== 'ADMIN' && user.id !== ownerId) {
    throw new AppError(403, 'You do not have access to this resource');
  }
};
