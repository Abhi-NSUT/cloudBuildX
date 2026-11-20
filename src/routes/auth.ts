import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';
import { JWT_SECRET } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../logger';

const BCRYPT_ROUNDS = 10;

// Body is already validated by registerSchema.
export const register = async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new AppError(409, 'Email already exists');

  // Only the bcrypt hash is stored, never the plain-text password.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  logger.info('User registered', { userId: user.id });
  res.status(201).json({ message: 'User registered successfully', userId: user.id });
};

// Body is already validated by loginSchema.
export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  const user = await prisma.user.findUnique({ where: { email } });

  // Same message for unknown email and wrong password so attackers can't enumerate accounts.
  const isValid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !isValid) {
    logger.warn('Failed login attempt');
    throw new AppError(401, 'Invalid credentials');
  }

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.status(200).json({ token, role: user.role });
};
