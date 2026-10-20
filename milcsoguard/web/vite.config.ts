import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :8080; production serves this build from the backend (same origin).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MG_API ?? 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
} as never);
