import express from 'express';
import cors from 'cors';
import { requireAuth, requireRole } from './middleware/auth';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import {
  validateBody,
  registerSchema,
  loginSchema,
  createBuildSchema,
  createRepositorySchema,
} from './validation';
import { createBuild, getBuilds, getBuildById, getBuildArtifact, getBuildLogs, cancelBuild } from './routes/builds';
import { createRepository, getRepositories } from './routes/repositories';
import { getDashboardAnalytics } from './routes/analytics';
import { getPlatformMetrics } from './routes/admin';
import { register, login } from './routes/auth';

// The Express app is built here without listening, so tests can drive it with supertest.
export const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(requestLogger);

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth
app.post('/auth/register', validateBody(registerSchema), register);
app.post('/auth/login', validateBody(loginSchema), login);

// Repositories
app.post('/api/repositories', requireAuth, validateBody(createRepositorySchema), createRepository);
app.get('/api/repositories', requireAuth, getRepositories);

// Builds (ownership enforced inside each handler: owner or admin)
app.post('/api/builds', requireAuth, validateBody(createBuildSchema), createBuild);
app.get('/api/builds', requireAuth, getBuilds);
app.get('/api/builds/:id', requireAuth, getBuildById);
app.get('/api/builds/:id/artifact', requireAuth, getBuildArtifact);
app.get('/api/builds/:id/logs', requireAuth, getBuildLogs);
app.post('/api/builds/:id/cancel', requireAuth, cancelBuild);

// Analytics
app.get('/api/analytics', requireAuth, getDashboardAnalytics);

// Admin only
app.get('/api/admin/metrics', requireAuth, requireRole('ADMIN'), getPlatformMetrics);

// Must be registered last
app.use(notFoundHandler);
app.use(errorHandler);
