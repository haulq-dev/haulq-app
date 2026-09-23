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
