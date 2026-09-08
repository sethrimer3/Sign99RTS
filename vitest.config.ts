import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic unit tests only — none of these launch Steam, Electron or a
    // browser. electron/lan.test.ts is included because electron/lan.cjs
    // itself has no dependency on the `electron` module — it's plain Node
    // (dgram/ws/dynamic import), so its lifecycle logic is testable exactly
    // like the rest of the LAN code.
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
    environment: 'node',
  },
});
