import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// The SPA lives at the root of the bot's origin (src/web/routes/spa.ts): in dev
// /api is proxied to Fastify (:3000), in production Fastify serves the build.
// WTBOT_API_URL in the repository root .env (npm --prefix frontend runs Vite
// from frontend/, hence '..') points the dev proxy at the production server,
// WTBOT_API_TOKEN is its WEB_TOKEN. Only the proxy adds the token; it never
// reaches the bundle: loadEnv reads only variables prefixed WTBOT_API_.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', 'WTBOT_API_')
  const target = env['WTBOT_API_URL'] || 'http://localhost:3000'
  const token = env['WTBOT_API_TOKEN']
  const backend: ProxyOptions = {
    target,
    changeOrigin: true,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    configure(proxy) {
      // The server rejects a POST with a foreign Origin (403), and the proxied
      // request reaches the target, not the Vite dev server.
      proxy.on('proxyReq', (proxyReq) => {
        if (proxyReq.getHeader('origin') !== undefined) proxyReq.setHeader('origin', new URL(target).origin)
      })
    },
  }
  return {
    base: '/',
    plugins: [react()],
    server: {
      // IPv4 on purpose: Node resolves 'localhost' to ::1, and VPN TUN clients
      // with strict route (sing-box on Windows) cut the IPv6 loopback.
      host: '127.0.0.1',
      // The bot dashboard (the top bar's link) comes from the server too.
      proxy: { '/api': backend, '/statistics': backend },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  }
})
