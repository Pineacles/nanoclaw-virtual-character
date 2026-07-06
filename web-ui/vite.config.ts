import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [react(), visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3003',
      '/uploads': 'http://localhost:3003',
      '/': {
        target: 'ws://localhost:3003',
        ws: true,
        // Only proxy WS upgrade requests — HTTP goes to Vite
        bypass(req) {
          if (req.headers.upgrade !== 'websocket') return req.url;
          return undefined;
        },
      },
    },
  },
});
