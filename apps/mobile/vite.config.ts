/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    // Tests read the same `.env.local` the dev server does, and a developer
    // building for a device sets `VITE_API_URL` there to the real API. Pinned
    // to the default here so a test's request URLs don't depend on whose
    // machine runs it.
    env: { VITE_API_URL: '/api' },
  },
  server: {
    // apps/web already owns 5173. Different port so both can run side by side
    // during development — a carrier issuing a link while testing the app
    // that opens it is the common case, not the exception.
    port: 5174,
    proxy: {
      '/api': {
        target: process.env['VITE_API_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
