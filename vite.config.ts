import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../dist-ui', emptyOutDir: true, target: 'es2022' },
});
