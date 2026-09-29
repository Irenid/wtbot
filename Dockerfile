# syntax=docker/dockerfile:1

# ---------- Сборка: backend (tsc) и SPA (vite) с dev-зависимостями ----------
FROM node:26-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY frontend ./frontend
RUN npm run build && npm run build:web && npm prune --omit=dev

# ---------- Рантайм: Node, Chromium под Xvfb и шрифты для рендера ----------
FROM node:26-bookworm-slim AS runtime

# chromium — транспорт warthunder.com (Cloudflare не пропускает headless,
#            поэтому браузер работает в обычном окне на виртуальном дисплее);
# xvfb     — виртуальный X-дисплей; x11vnc — опциональный доступ к нему для
#            ручной проверки Cloudflare (включается WT_VNC_PASSWORD);
# fonts-*  — шрифты, которые ищет src/workers/render-fonts.ts на Linux.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-dejavu-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    tzdata \
    x11vnc \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_HOST=0.0.0.0 \
    DB_PATH=/app/data/wtbot.db \
    WT_BROWSER_EXECUTABLE=/usr/bin/chromium \
    WT_BROWSER_PROFILE_DIR=/app/data/wt-browser-profile \
    WT_BROWSER_NO_SANDBOX=true \
    DISPLAY=:99

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY LICENSE ./
# BSD-3-Clause (п. 2) требует текст лицензии и в сборке, а не только в исходниках.
COPY LICENSES/*.txt ./LICENSES/
COPY docker/entrypoint.sh /usr/local/bin/wtbot-entrypoint
# CRLF из Windows-копии репозитория сломал бы shebang, поэтому нормализуем.
RUN sed -i 's/\r$//' /usr/local/bin/wtbot-entrypoint \
  && chmod 0755 /usr/local/bin/wtbot-entrypoint \
  && mkdir -p /app/data \
  && chown node:node /app/data

EXPOSE 3000
# Проверка готовности: /health не требует авторизации и не трогает SQLite.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["wtbot-entrypoint"]
CMD ["node", "dist/index.js"]
