import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Express server serves the build at /app (see src/index.ts), so the app is
// built with that base path and emitted straight into server/public/app.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../public/app', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    // Same-origin in development too, so the SameSite=Strict session cookie works.
    proxy: { '/api': 'http://localhost:4000' },
  },
  test: { include: ['src/**/*.test.ts'] },
});
