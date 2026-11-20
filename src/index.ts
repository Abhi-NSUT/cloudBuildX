import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { app } from './app';
import { prisma } from './db';
import { verifyToken, AuthUser } from './middleware/auth';
import { logger } from './logger';
import { createRedis } from './clients';

const port = process.env.PORT || 3000;

// 1. Wrap Express in a native HTTP server
const server = http.createServer(app);

// 2. Initialize Socket.io
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// 3. Dedicated Redis subscriber connection (a subscribed connection can't run other commands).
// One pattern subscription covers every build, so there is nothing to subscribe or
// clean up per viewer: Socket.io rooms decide who receives which build's lines.
const subscriber = createRedis();
subscriber.psubscribe('build-logs:*');

// 4. Authenticate every socket with the same JWT as the REST API
io.use((socket, next) => {
  const raw = String(socket.handshake.auth?.token ?? '');
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw;
  try {
    socket.data.user = verifyToken(token);
    next();
  } catch {
    logger.warn('Rejected unauthenticated socket connection', { socketId: socket.id });
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user as AuthUser;
  logger.debug('Socket connected', { socketId: socket.id, userId: user.id });

  // Only the build's owner (or an admin) may stream its logs
  socket.on('subscribeToBuild', async (buildId: string) => {
    try {
      const build = await prisma.build.findUnique({
        where: { id: String(buildId) },
        select: { repository: { select: { userId: true } } },
      });

      if (!build || (user.role !== 'ADMIN' && build.repository.userId !== user.id)) {
        logger.warn('Socket subscription denied', { buildId, userId: user.id });
        socket.emit('build-log', { type: 'error', text: 'You do not have access to this build.' });
        return;
      }

      socket.join(buildId);
    } catch (error: any) {
      logger.error('Socket subscription failed', { buildId, error: error.message, stack: error.stack });
    }
  });

  socket.on('disconnect', () => {
    logger.debug('Socket disconnected', { socketId: socket.id });
  });
});

// 5. Relay worker log lines from Redis to the right socket room
subscriber.on('pmessage', (_pattern, channel, message) => {
  const buildId = channel.slice('build-logs:'.length);
  try {
    io.to(buildId).emit('build-log', JSON.parse(message));
  } catch (error: any) {
    logger.error('Invalid log message from Redis', { channel, error: error.message });
  }
});

// Last-resort safety nets: log, don't die silently
process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled promise rejection', { error: reason?.message ?? String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, shutting down', { error: error.message, stack: error.stack });
  process.exit(1);
});

server.listen(port, () => {
  logger.info(`CloudBuildX API & WebSocket server running on port ${port}`);
});
