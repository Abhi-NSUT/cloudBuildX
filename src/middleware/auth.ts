import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Extend the Express Request type to include our user object
export interface AuthRequest extends Request {
  user?: { id: string };
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Note: In production, load this secret from process.env.JWT_SECRET
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'YOUR_SUPER_SECRET_KEY') as { id: string };
    
    // Attach the decoded user payload to the request object
    req.user = decoded; 
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }
};
