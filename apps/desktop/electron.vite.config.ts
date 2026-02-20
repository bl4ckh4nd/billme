import path from 'path';
import { defineConfig } from 'electron-vite';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    main: {
      build: {
        outDir: 'dist/main',
        lib: {
          entry: path.resolve(__dirname, 'electron/main.ts'),
        },
        rollupOptions: {
          external: ['better-sqlite3', 'keytar', 'electron-updater'],
          output: {
            entryFileNames: 'index.js',
          },
        },
      },
    },
    preload: {
      build: {
        outDir: 'dist/preload',
        lib: {
          entry: path.resolve(__dirname, 'electron/preload.ts'),
        },
        rollupOptions: {
          output: {
            // Electron preload runs as CommonJS by default.
            format: 'cjs',
            entryFileNames: 'index.cjs',
            exports: 'named',
          },
        },
      },
    },
    renderer: {
      // electron-vite defaults the renderer root to `src/renderer`.
      // This repo currently keeps `index.html` at the project root.
      root: __dirname,
      plugins: [tailwindcss(), react()],
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      define: {
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        },
      },
      build: {
        outDir: 'dist/renderer',
        // In production, keep asset paths relative for `loadFile(...)`.
        base: './',
        rollupOptions: {
          input: path.resolve(__dirname, 'index.html'),
        },
      },
    },
  };
});
