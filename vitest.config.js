import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    // Windows CI runners are slow: the first request of a file (password hashing, cold start) can pass the 5s default.
    testTimeout: 30000,
    setupFiles: ['tests/setup/licenseIndexReady.js'],
  },
});
