import jwt from 'jsonwebtoken';
import { Response } from 'express';
import { requireAuth, requireRole, AuthRequest } from '../src/middleware/auth';

const mockRes = () => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const reqWithHeader = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as AuthRequest;

describe('requireAuth', () => {
  it('returns 401 for a missing header, a non-Bearer header, or a forged token', () => {
    const forged = `Bearer ${jwt.sign({ id: 'u1', role: 'ADMIN' }, 'wrong-secret')}`;

    for (const header of [undefined, 'Basic abc123', forged]) {
      const res = mockRes();
      const next = jest.fn();
      requireAuth(reqWithHeader(header), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('attaches the user and role for a valid token (old tokens without a role default to USER)', () => {
    const adminReq = reqWithHeader(`Bearer ${jwt.sign({ id: 'a1', role: 'ADMIN' }, 'test-secret')}`);
    const legacyReq = reqWithHeader(`Bearer ${jwt.sign({ id: 'u1' }, 'test-secret')}`);
    const next = jest.fn();

    requireAuth(adminReq, mockRes(), next);
    requireAuth(legacyReq, mockRes(), next);

    expect(adminReq.user).toEqual({ id: 'a1', role: 'ADMIN' });
    expect(legacyReq.user).toEqual({ id: 'u1', role: 'USER' });
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('requireRole', () => {
  it('blocks a USER with 403 and lets an ADMIN through', () => {
    const adminOnly = requireRole('ADMIN');

    const userRes = mockRes();
    const userNext = jest.fn();
    adminOnly({ user: { id: 'u1', role: 'USER' } } as AuthRequest, userRes, userNext);
    expect(userRes.status).toHaveBeenCalledWith(403);
    expect(userNext).not.toHaveBeenCalled();

    const adminNext = jest.fn();
    adminOnly({ user: { id: 'a1', role: 'ADMIN' } } as AuthRequest, mockRes(), adminNext);
    expect(adminNext).toHaveBeenCalled();
  });
});
