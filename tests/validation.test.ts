import { registerSchema, createBuildSchema } from '../src/validation';

describe('registerSchema', () => {
  it('accepts a valid body and rejects bad emails and short passwords', () => {
    expect(registerSchema.safeParse({ email: 'dev@example.com', password: 'password123' }).success).toBe(true);

    const badEmail = registerSchema.safeParse({ email: 'not-an-email', password: 'password123' });
    expect(badEmail.success).toBe(false);
    expect(badEmail.error?.issues[0]?.path).toEqual(['email']);

    const shortPassword = registerSchema.safeParse({ email: 'dev@example.com', password: 'short' });
    expect(shortPassword.success).toBe(false);
    expect(shortPassword.error?.issues[0]?.message).toBe('Password must be at least 8 characters');
  });
});

describe('createBuildSchema', () => {
  const repositoryId = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

  it('requires a UUID repositoryId and an optional hex commit SHA', () => {
    expect(createBuildSchema.safeParse({ repositoryId }).success).toBe(true);
    expect(createBuildSchema.safeParse({ repositoryId, commitHash: 'a1b2c3d' }).success).toBe(true);

    expect(createBuildSchema.safeParse({}).success).toBe(false);
    expect(createBuildSchema.safeParse({ repositoryId: '123' }).success).toBe(false);
    expect(createBuildSchema.safeParse({ repositoryId, commitHash: 'main; rm -rf /' }).success).toBe(false);
  });
});
