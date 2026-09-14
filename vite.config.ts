import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  build: { outDir: '../dist-app', emptyOutDir: true },
  server: { port: 5180 },
});
