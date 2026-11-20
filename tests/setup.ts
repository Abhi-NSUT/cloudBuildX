// Runs before every test file, before any app module is imported.
process.env.NODE_ENV = 'test'; // silences the Winston logger
process.env.JWT_SECRET = 'test-secret';
