import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  // Proxy instead of CORS: the API is same-origin in dev and in prod.
  // src/trading.ts lives outside web/ and is shared with the API: one copy of the money maths.
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
