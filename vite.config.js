import { defineConfig } from 'vite';

export default defineConfig({
  // Allow large Timeline.json files to be opened without timeout
  server: {
    fs: { strict: false },
  },
  build: {
    target: 'chrome94', // WebCodecs minimum
    rollupOptions: {
      output: {
        manualChunks: {
          'mp4-muxer': ['mp4-muxer'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
