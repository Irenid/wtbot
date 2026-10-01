# wtbot

Discord-бот, сайт и сборщик статистики клановых боёв War Thunder в одном
Node.js-процессе. Бот собирает реплеи с warthunder.com, разбирает `.wrpl` и
хранит бои, игроков, убийства и чат в SQLite. Результаты видны в Discord
(`/battle`, автоанонсы, табло игроков из голосовых каналов) и на сайте `/app`.

## Документация

| Файл | Что в нём |
| --- | --- |
| [README.md](README.md) | запуск, проверки, бэкап, безопасность |
| [AGENTS.md](AGENTS.md) | архитектура и контракты для разработчиков и агентов |
| [ROADMAP.md](ROADMAP.md) | единственный список открытых задач |
| [docs/performance.md](docs/performance.md) | замеры производительности, gates, rollback |
| [docs/replay-data-quality.md](docs/replay-data-quality.md) | что можно и нельзя извлечь из реплеев |
| [LICENSES/](LICENSES/README.md) | лицензии портированного кода |

## Где что запускается

| Среда | Назначение | Как |
| --- | --- | --- |
| Docker на Linux | боевой запуск | `docker compose up -d --build` |
| Windows | разработка и тесты | `npm run dev`, `npm test`, `npm run verify` |

Сбор данных с warthunder.com идёт через настоящий браузер (Edge/Chromium) в
обычном окне: Cloudflare не пропускает ни прямые запросы Node, ни headless.
В Docker окно открывается на виртуальном дисплее Xvfb внутри контейнера.

## Требования

- Node.js **≥ 22.15** (проверено на 24) — только для разработки на Windows.
- Docker Engine с Compose — для боевого запуска.
- Discord-бот (токен) и авторизованная сессия warthunder.com (`WT_COOKIE`).

## Боевой запуск в Docker

1. Скопируйте `.env.example` в `.env` и заполните как минимум `TOKEN`,
   `WT_COOKIE` и **`WEB_TOKEN`**: внутри контейнера сервер слушает `0.0.0.0`,
   поэтому без токена он не стартует.
2. Положите данные в `./data` рядом с `docker-compose.yml`. При переезде с
   Windows скопируйте `wtbot.db`, `wt-cookies.json`, `fonts/`, `wt-vehicles.json`,
   `ecshashes.json`, `maps/`, `missions/`. Профиль браузера
   (`wt-browser-profile/`) не переносите: он привязан к Windows, в контейнере
   создастся новый. Флаги наций бот берёт из клиента игры: скопируйте из
   установленной War Thunder `ui/fonts.vromfs.bin` и `ui/atlases.vromfs.bin` в
   `data/wt-game/ui/` и перезапустите бота; без них флаги рисуются упрощёнными.
3. Запустите: `docker compose up -d --build`. Логи: `docker compose logs -f wtbot`.
4. Сайт: `http://127.0.0.1:3000/app` на самом сервере. Браузер спросит логин и
   пароль: имя любое, пароль — `WEB_TOKEN`. Для доступа из сети поставьте перед
   ботом reverse proxy с TLS (nginx, caddy) и задайте `WEB_TRUST_PROXY`.
5. Если Cloudflare требует ручную проверку или нужно войти на warthunder.com
   заново: задайте `WT_VNC_PASSWORD`, раскомментируйте порт `5900` в
   `docker-compose.yml` и подключитесь VNC-клиентом к `127.0.0.1:5900`.

Контейнер `wtbot` перезапускается сам после падения (`restart: unless-stopped`),
`docker compose stop` делает штатную остановку (SIGTERM). Сервис `backup`
каждый день в `WTBOT_BACKUP_TIME` (по умолчанию 04:30 по `TZ`, по умолчанию UTC)
кладёт проверенную копию базы в `./backups` и хранит 3 последние.

## Разработка на Windows

```powershell
npm ci
npm --prefix frontend ci
copy .env.example .env   # заполните TOKEN, WT_COOKIE, WT_PLAYER_NAMES
npm run dev              # бот + сайт http://127.0.0.1:3000 + парсеры
```

Боевая база одна — на сервере с Docker; бот с тем же `TOKEN` локально не
запускайте, иначе анонсы в Discord задвоятся. SPA на данных сервера без
локальной БД: задайте в `.env` `WTBOT_API_URL` (адрес сайта за reverse proxy) и
`WTBOT_API_TOKEN` (его `WEB_TOKEN`), затем `npm run dev:web` →
`http://127.0.0.1:5173/app/`.
Сайт на локальной копии БД без бота: `npm run site` → `http://127.0.0.1:3210/app`.
Демо на тестовых реплеях без БД: `npx tsx src/analysis/site-preview.ts`.
Остановка — `Ctrl+C` в консоли. Макеты дизайн-системы сайта — `frontend/design/`.

## Проверки

```powershell
npm run build            # backend в dist/ (без тестов)
npm run verify           # typecheck, npm test и все офлайн-smoke
npm run verify:workers:dist
npm run build:web        # SPA в frontend/dist/
```

Эти команды не ходят в сеть и не трогают `data/`. То же выполняет CI на Linux и
Windows (`.github/workflows/ci.yml`), он же собирает Docker-образ.

## Бэкап и восстановление

- Разовый бэкап: `npm run db:backup` (или
  `docker compose run --rm --no-deps backup node dist/analysis/db-backup.js /backups 3`;
  без `--no-deps` Compose пересоздаёт работающий `wtbot`, если его конфигурация
  изменилась). Копия создаётся через `VACUUM INTO`, проверяется
  `PRAGMA quick_check` и публикуется атомарно.
- Восстановление: остановите бота, проверьте выбранную копию `quick_check`,
  переименуйте текущую `wtbot.db` в `wtbot.db.pre-restore`, скопируйте копию
  на место `DB_PATH`, запустите бота без `WTBOT_ALLOW_NEW_DB` и проверьте `/health`.

Части реплеев живут на CDN около двух недель: бои за время простоя дольше
этого срока собрать уже нельзя.

## Безопасность

- По умолчанию сайт слушает только `127.0.0.1` и отклоняет чужой `Host`
  (DNS rebinding) и кросс-доменные POST (CSRF).
- В сетевом режиме нужен `WEB_TOKEN` (Bearer или пароль HTTP Basic).
- Не публикуйте `.env`, `data/wt-cookies.json` и `data/wtbot.db`: там токены,
  cookies, Discord ID и чат боёв.

## Лицензия

GNU AGPL-3.0-or-later, см. [LICENSE](LICENSE). Часть `src/wrpl/*` — порт
[wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector) (AGPL-3.0),
`src/wrpl/gm-sync.ts` основан на
[WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser) и Dagor
Engine (BSD-3-Clause); происхождение указано в заголовках файлов, тексты
лицензий — в [LICENSES/](LICENSES/README.md). Сайт и
дашборд показывают ссылку на исходный код, как требует AGPL для сетевых сервисов.
