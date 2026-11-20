import { Response, NextFunction } from 'express';
import { logger } from '../logger';
import { AuthRequest } from './auth';

// Logs one line per request once the response has been sent.
export const requestLogger = (req: AuthRequest, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger.log(level, `${req.method} ${req.originalUrl} ${res.statusCode}`, {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?.id,
      ip: req.ip,
    });
  });

  next();
};
