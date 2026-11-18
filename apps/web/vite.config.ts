import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: '../../', // eine gemeinsame .env im Repo-Wurzelverzeichnis
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
});
