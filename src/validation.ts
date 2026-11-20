import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email('A valid email is required').max(254),
  // bcrypt only uses the first 72 bytes of a password
  password: z
    .string('Password is required')
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters'),
});

export const loginSchema = z.object({
  email: z.email('A valid email is required'),
  password: z.string('Password is required').min(1, 'Password is required'),
});

export const createBuildSchema = z.object({
  repositoryId: z.uuid('repositoryId must be a valid UUID'),
  commitHash: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'commitHash must be a 7-40 character hex SHA')
    .optional(),
});

export const createRepositorySchema = z.object({
  name: z.string('name is required').trim().min(1, 'name is required').max(100),
  githubUrl: z.url('githubUrl must be a valid URL'),
});

// Validates req.body against a schema. On failure responds 400 with
// a readable top-level message plus per-field details.
export const validateBody =
  (schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      }));
      return res.status(400).json({
        error: details[0]?.message ?? 'Validation failed',
        details,
      });
    }
    req.body = result.data;
    next();
  };
