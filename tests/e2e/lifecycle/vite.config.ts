import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ root: __dirname, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 4189, strictPort: true } });
