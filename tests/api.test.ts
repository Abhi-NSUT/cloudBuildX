import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Replace the database and Redis/BullMQ with in-memory mocks so the
// real Express app can be exercised without any infrastructure.
jest.mock('../src/db', () => ({
  prisma: {
    user: { findUnique: jest.fn(), create: jest.fn() },
    build: { findUnique: jest.fn() },
  },
}));
jest.mock('../src/queue', () => ({
  buildQueue: { add: jest.fn() },
  redisConnection: { publish: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));

import { app } from '../src/app';
import { prisma } from '../src/db';

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; create: jest.Mock };
  build: { findUnique: jest.Mock };
};

const tokenFor = (id: string, role: 'USER' | 'ADMIN' = 'USER') =>
  `Bearer ${jwt.sign({ id, role }, 'test-secret')}`;

describe('POST /auth/register', () => {
  it('returns 400 with field details for an invalid body and never touches the database', async () => {
    const res = await request(app).post('/auth/register').send({ email: 'nope', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['email', 'password']);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login', () => {
  const user = { id: 'u1', email: 'dev@example.com', role: 'USER', passwordHash: '' };

  beforeAll(async () => {
    user.passwordHash = await bcrypt.hash('password123', 4);
  });

  it('returns a JWT carrying the user id and role for correct credentials', async () => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await request(app).post('/auth/login').send({ email: user.email, password: 'password123' });

    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, 'test-secret')).toMatchObject({ id: 'u1', role: 'USER' });
  });

  it('returns 401 for a wrong password', async () => {
    db.user.findUnique.mockResolvedValue(user);

    const res = await request(app).post('/auth/login').send({ email: user.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });
});

describe('GET /api/builds/:id', () => {
  const build = { id: 'b1', status: 'SUCCESS', repository: { userId: 'owner-1' } };

  it("forbids reading another user's build but allows the owner and admins", async () => {
    db.build.findUnique.mockResolvedValue(build);

    const stranger = await request(app).get('/api/builds/b1').set('Authorization', tokenFor('someone-else'));
    const owner = await request(app).get('/api/builds/b1').set('Authorization', tokenFor('owner-1'));
    const admin = await request(app).get('/api/builds/b1').set('Authorization', tokenFor('admin-1', 'ADMIN'));

    expect(stranger.status).toBe(403);
    expect(owner.status).toBe(200);
    expect(admin.status).toBe(200);
  });

  it('turns an unexpected failure into a clean 500 JSON error without leaking details', async () => {
    db.build.findUnique.mockRejectedValue(new Error('connection to database lost'));

    const res = await request(app).get('/api/builds/b1').set('Authorization', tokenFor('owner-1'));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
