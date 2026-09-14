import { defineConfig } from 'vitest/config';

// Separate config for performance benchmarks — deliberately NOT picked up by
// the main `npm test` (vitest.config.ts only globs *.test.ts; benchmark files
// use *.bench.ts so they never run as part of the normal fast suite). Battles
// at high fighter counts can take a while, so timeouts here are generous.
export default defineConfig({
  test: {
    include: ['src/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    // Benchmarks measure wall-clock time — run one file/worker at a time so
    // unrelated parallel test processes don't skew frame timings.
    fileParallelism: false,
  },
});
