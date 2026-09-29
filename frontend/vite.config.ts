import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// SPA живёт на /app того же origin: в dev API проксируется в Fastify (:3000),
// в production собранную статику раздаёт сам Fastify через @fastify/static.
// WTBOT_API_URL в .env корня репозитория (npm --prefix frontend запускает Vite
// из frontend/, отсюда '..') направляет dev-прокси на боевой сервер, а
// WTBOT_API_TOKEN — его WEB_TOKEN. Токен добавляет только прокси, в клиентский
// бандл он не попадает: loadEnv читает лишь переменные с префиксом WTBOT_API_.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', 'WTBOT_API_')
  const target = env['WTBOT_API_URL'] || 'http://localhost:3000'
  const token = env['WTBOT_API_TOKEN']
  return {
    base: '/app/',
    plugins: [react()],
    server: {
      // IPv4 явно: 'localhost' Node отдаёт как ::1, а TUN-клиенты VPN со
      // strict route (sing-box на Windows) режут IPv6 loopback.
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
          configure(proxy) {
            // POST с чужим Origin сервер отклоняет 403, а для него запрос
            // приходит на target, не на dev-сервер Vite.
            proxy.on('proxyReq', (proxyReq) => {
              if (proxyReq.getHeader('origin') !== undefined) proxyReq.setHeader('origin', new URL(target).origin)
            })
          },
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  }
})
