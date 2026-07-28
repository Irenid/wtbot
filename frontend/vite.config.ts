import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA живёт на /app того же origin: в dev API проксируется в Fastify (:3000),
// в production собранную статику раздаёт сам Fastify через @fastify/static.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
