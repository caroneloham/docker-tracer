import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { 'import.meta.env.VITE_DTR_BROWSER': JSON.stringify('1') },
  build: {
    target: 'es2022',
    outDir: 'dist-browser',
    emptyOutDir: true,
    rollupOptions: { input: 'browser.html' },
  },
});
