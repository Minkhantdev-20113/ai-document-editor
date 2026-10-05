import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Build configuration.
// - Worker bundles are ESM so heavy PDF work shares one import graph and runs
//   entirely off the main UI thread.
// - The editor is split out so the app shell paints before Tiptap loads.
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@tiptap') || id.includes('node_modules/prosemirror')) {
            return 'editor';
          }
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
