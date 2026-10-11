import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/*.test.js',
      'starter-app/**/*.test.js',
      'starter-web/src/auth/**/*.test.js',
      'scripts/**/*.test.js',
    ],
  },
});
