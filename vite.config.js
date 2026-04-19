import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true, // listen on all interfaces (LAN accessible)
  },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    chunkSizeWarningLimit: 2000,
  },
});
