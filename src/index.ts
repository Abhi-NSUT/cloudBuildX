import express from 'express';
import { requireAuth } from './middleware/auth';
import { createBuild } from './routes/builds';
import { createRepository } from './routes/repositories';
import { register, login } from './routes/auth';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Healthcheck route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes
app.post('/auth/register', register);
app.post('/auth/login', login);

// Protect the route with requireAuth middleware
app.post('/api/repositories', requireAuth, createRepository);
app.post('/api/builds', requireAuth, createBuild);

app.listen(port, () => {
  console.log(`CloudBuildX API is running on port ${port}`);
});