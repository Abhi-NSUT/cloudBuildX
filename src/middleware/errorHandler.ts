import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

// Throw this from any route to send a specific status code and message.
export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

// Catches requests that matched no route.
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
};

// Single place where every failure becomes a clean JSON response.
// Express 5 forwards rejected promises from async handlers here automatically.
export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error(err.message, { path: req.originalUrl, stack: err.stack });
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  logger.error('Unhandled error', {
    method: req.method,
    path: req.originalUrl,
    error: err?.message,
    stack: err?.stack,
  });

  // Never leak internals (stack traces, SQL) to the client.
  return res.status(500).json({ error: 'Internal server error' });
};
