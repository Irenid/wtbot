# wtbot

Discord-бот, сайт и сборщик статистики клановых боёв War Thunder в одном
Node.js-процессе. Бот собирает реплеи с warthunder.com, разбирает `.wrpl` и
хранит бои, игроков, убийства и чат в SQLite. Результаты — в Discord
(`/battle`, автоанонсы, табло игроков из голосовых каналов) и на сайте `/app`.

## Документация

| Файл | Что в нём |
| --- | --- |
| [AGENTS.md](AGENTS.md) | архитектура и контракты для разработчиков и агентов |
| [ROADMAP.md](ROADMAP.md) | единственный список открытых задач |
| [docs/database.md](docs/database.md) | база: замеры, формат блобов, ошибки в данных, откат миграций |
| [docs/performance.md](docs/performance.md) | замеры производительности, gates, откат |
| [docs/replay-data-quality.md](docs/replay-data-quality.md) | что можно и нельзя извлечь из реплеев |
| [LICENSES/](LICENSES/README.md) | лицензии портированного кода |

## Где что запускается

| Среда | Назначение | Как |
| --- | --- | --- |
| Docker на Linux | боевой запуск | `docker compose up -d --build` |
| Linux или Windows | разработка и тесты | `npm run dev`, `npm test`, `npm run verify` |

Warthunder.com опрашивается прямыми запросами. Адреса, которые проверяет
Cloudflare (профиль и поиск игроков), открывает настоящий браузер
(Edge/Chromium) в обычном окне — headless проверку не проходит; в Docker окно
живёт на виртуальном дисплее Xvfb.

Требования: Docker Engine с Compose (боевой запуск), Node.js ≥ 22.15
(разработка; CI проверяет 24 на Windows и 26 на Linux, как в образе),
Discord-бот (токен) и авторизованная сессия warthunder.com (`WT_COOKIE`).

## Боевой запуск в Docker

1. Скопируйте `.env.example` в `.env` и заполните как минимум `TOKEN`,
   `WT_COOKIE` и **`WEB_TOKEN`**: в контейнере сервер слушает `0.0.0.0` и без
   токена не стартует.
2. Положите данные в `./data` рядом с `docker-compose.yml`; при переезде —
   `wtbot.db`, `wt-cookies.json`, `fonts/`, `wt-vehicles.json`,
   `ecshashes.json`, `maps/`, `missions/`. Профиль браузера
   (`wt-browser-profile/`) не переносите: он привязан к ОС, в контейнере
   создастся новый. Флаги наций — из клиента игры: скопируйте
   `ui/fonts.vromfs.bin` и `ui/atlases.vromfs.bin` в `data/wt-game/ui/` и
   перезапустите бота; без них флаги рисуются упрощёнными.
3. `docker compose up -d --build`; логи — `docker compose logs -f wtbot`.
4. Сайт — `http://127.0.0.1:3000/app` на самом сервере: имя любое, пароль —
   `WEB_TOKEN`. Для доступа из сети поставьте перед ботом reverse proxy с TLS
   (nginx, caddy) и задайте `WEB_TRUST_PROXY`.
5. Cloudflare требует ручную проверку или нужен новый вход на warthunder.com —
   задайте `WT_VNC_PASSWORD`, раскомментируйте порт `5900` в
   `docker-compose.yml` и подключитесь VNC-клиентом к `127.0.0.1:5900`.

`wtbot` перезапускается после падения (`restart: unless-stopped`),
`docker compose stop` — штатная остановка (SIGTERM). Сервис `backup` каждый
день в `WTBOT_BACKUP_TIME` (по умолчанию 04:30 по `TZ`, по умолчанию UTC)
кладёт проверенную копию базы в `./backups` и хранит 3 последние.

Обновление: пометьте работающий образ для отката
(`docker tag wtbot:latest wtbot:pre-<версия>`), снимите разовый бэкап (ниже) и
убедитесь, что файл на месте, затем `docker compose up -d --build`. Миграция
схемы необратима: прежний образ новую базу не откроет, откат — бэкапом
([docs/database.md](docs/database.md)).

Образ сам не обновляется, а его Chromium ходит на warthunder.com и StatShark:
исправления безопасности браузера и Debian приходят только с пересборкой без
кэша слоёв (иначе слой `apt-get` останется старым) — раз в одну-две недели
`docker compose build --pull --no-cache` и `docker compose up -d`, лучше вне
вечерних полковых боёв.

## Разработка

```bash
npm ci
npm --prefix frontend ci
cp .env.example .env     # Windows: copy; заполните TOKEN, WT_COOKIE, WT_PLAYER_NAMES
npm run dev              # бот + сайт http://127.0.0.1:3000 + парсеры
```

Боевая база одна — у бота в Docker; бот с тем же `TOKEN` локально не
запускайте, иначе анонсы в Discord задвоятся. Если рабочая копия — каталог,
из которого запущен compose, её `data/` — данные работающего бота: `npm run dev`,
`npm run battle` и backfill пишут в боевую базу.

- SPA на данных сервера без локальной БД: `WTBOT_API_URL` (адрес сайта за
  reverse proxy) и `WTBOT_API_TOKEN` (его `WEB_TOKEN`) в `.env`, затем
  `npm run dev:web` → `http://127.0.0.1:5173/app/`.
- Сайт на базе `DB_PATH` без бота: `npm run site` → `http://127.0.0.1:3210/app`.
- Демо на синтетических данных без БД: `npx tsx src/analysis/site-preview.ts`
  (тот же адрес).
- Макеты дизайн-системы сайта — `frontend/design/`. Остановка — `Ctrl+C`.

## Проверки

```bash
npm run build            # backend в dist/ (без тестов)
npm run verify           # typecheck, npm test и все офлайн-smoke
npm run verify:workers:dist
npm run build:web        # SPA в frontend/dist/
```

Без сети и без записи в рабочую базу: тесты и smoke работают на SQLite
`:memory:` и временных файлах. То же выполняет CI на Linux и Windows
(`.github/workflows/ci.yml`), он же собирает Docker-образ.

## Бэкап и восстановление

- Разовый бэкап: `npm run db:backup` или
  `docker compose run --rm --no-deps backup node dist/analysis/db-backup.js /backups 3`
  (без `--no-deps` Compose пересоздаст работающий `wtbot`, если его
  конфигурация изменилась). Копия — `VACUUM INTO`, проверка
  `PRAGMA quick_check`, атомарная публикация.
- Восстановление: остановите бота, проверьте копию `quick_check`, переименуйте
  текущую `wtbot.db` в `wtbot.db.pre-restore`, положите копию на место
  `DB_PATH`, запустите бота без `WTBOT_ALLOW_NEW_DB` и проверьте `/health`.

Части реплеев живут на CDN около двух недель: бои за более долгий простой
уже не собрать.

## Безопасность

- По умолчанию сайт слушает только `127.0.0.1` и отклоняет чужой `Host` (DNS
  rebinding) и кросс-доменные POST (CSRF); в сетевом режиме нужен `WEB_TOKEN`
  (Bearer или пароль HTTP Basic).
- Не публикуйте `.env`, `data/wt-cookies.json` и `data/wtbot.db`: там токены,
  cookies, Discord ID и чат боёв.

## Лицензия

GNU AGPL-3.0-or-later, см. [LICENSE](LICENSE). Часть `src/wrpl/*` — порт
[wrpl-inspector](https://github.com/maxsupermanhd/wrpl-inspector) (AGPL-3.0),
`src/wrpl/gm-sync.ts` основан на
[WrplReplayParser](https://github.com/LivingTheDagor/WrplReplayParser) и Dagor
Engine (BSD-3-Clause); происхождение — в заголовках файлов, тексты лицензий —
в [LICENSES/](LICENSES/README.md). Сайт и дашборд показывают ссылку на
исходный код, как требует AGPL для сетевых сервисов.
