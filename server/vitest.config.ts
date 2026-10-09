import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // One schema, shared state across files: run files serially so a test that
    // locks or deletes cannot interleave with another's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      NW_NO_LISTEN: '1',
      // Fake texts and files from the stubs go here, not into the developer's .devdata/.
      DEV_DATA_DIR: path.join(os.tmpdir(), `nw-test-devdata-${process.pid}`),
      // A fixed 32-byte key (base64) so encrypted TOTP secrets are stable within
      // a run. It protects nothing real — the schema is thrown away.
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      BOOKING_MODE: 'demo',
      APP_BASE_URL: 'http://localhost:4000',
    },
  },
});
