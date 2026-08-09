import express from 'express';
import cors from 'cors';
import { requireAuth } from './middleware/auth';
import { createBuild, getBuilds, getBuildById, getBuildArtifact, getBuildLogs, cancelBuild } from './routes/builds';
import { createRepository } from './routes/repositories';
import { register, login } from './routes/auth';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import IORedis from 'ioredis';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
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
app.get('/api/builds', requireAuth, getBuilds);
app.get('/api/builds/:id', requireAuth, getBuildById);
app.get('/api/builds/:id/artifact', requireAuth, getBuildArtifact);
app.get('/api/builds/:id/logs', requireAuth, getBuildLogs);
app.post('/api/builds/:id/cancel', requireAuth, cancelBuild);

// 1. Wrap Express in a native HTTP server
const server = http.createServer(app);

// 2. Initialize Socket.io
const io = new SocketIOServer(server, {
  cors: {
    origin: '*', // For Day 5, restrict this to your React app's URL
    methods: ['GET', 'POST']
  }
});

// 3. Create a dedicated Redis Subscriber connection
const subscriber = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
});

// 4. Handle WebSocket Connections
io.on('connection', (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  // When the React app mounts the build details page, it emits this event
  socket.on('subscribeToBuild', async (buildId: string) => {
    console.log(`Client ${socket.id} subscribed to logs for build: ${buildId}`);
    
    // Put the socket in a specific "room" for this build
    socket.join(buildId);
    
    // Tell Redis we want to listen to this channel
    await subscriber.subscribe(`build-logs:${buildId}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
  });
});

// 5. Global Redis Message Listener
// When Redis receives a message from the Worker, it triggers this.
subscriber.on('message', (channel, message) => {
  if (channel.startsWith('build-logs:')) {
    const buildId = channel.split(':')[1];
    
    // Broadcast the message ONLY to sockets currently in this build's room
    io.to(buildId).emit('build-log', JSON.parse(message));
  }
});

server.listen(port, () => {
  console.log(`CloudBuildX API & WebSocket Server running on port ${port}`);
});