import { defineConfig } from 'vite';
export default defineConfig({
  server: {
    port: 18791,
    strictPort: true,
    proxy: {
      '/save': {
        target: 'http://127.0.0.1:18792',
        changeOrigin: true,
      },
    },
  },
});
