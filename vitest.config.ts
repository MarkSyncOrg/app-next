import { defineConfig } from 'vitest/config';

// Unit tests for the core logic now live in @marksyncorg/core. This project keeps
// only its end-to-end suite (Playwright) plus any future webext-specific unit tests,
// so the runner must not fail when there are no unit test files yet.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/types/**'],
    },
  },
});
