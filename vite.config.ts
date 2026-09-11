import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // No file-size constraint — this port prioritises fidelity over bundle size.
    chunkSizeWarningLimit: 100_000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        shiplab: resolve(__dirname, 'shiplab.html'),
      },
    },
  },
  publicDir: 'public',
});
