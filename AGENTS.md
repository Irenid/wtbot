# AGENTS.md

# Codex instructions

## Работа с монорепозиторием

* Сначала используй codebase-memory-mcp для поиска структуры проекта, файлов, функций и связей между ними.
* Не читай весь репозиторий рекурсивно.
* Открывай только файлы, относящиеся к текущей задаче.
* Перед изменениями перечисли файлы и функции, которые планируется изменить.
* Перед изменением общей функции проверь, кто её вызывает.
* После изменений оцени, какие другие части проекта могут быть затронуты.
* Не выполняй посторонний рефакторинг.

## Команды терминала

* Используй RTK для Git, поиска, тестов, сборки и линтеров.
* Предпочитай `rtk git status`, `rtk git diff`, `rtk grep` и RTK-обёртки тестов.
* Сначала запускай тесты только затронутого модуля.
* Полный набор тестов запускай только при необходимости.

## О проекте

`wtbot` — модульный монолит на TypeScript: Discord-бот, Fastify-дашборд и
фоновые парсеры работают в основном Node.js-потоке, а тяжёлый разбор `.wrpl`,
zlib/zstd/gzip и SVG -> PNG выполняет ограниченный пул `worker_threads`.
Общая точка входа — `src/index.ts`, хранилище — синхронная SQLite из
`src/db/index.ts`.

Проект собирает клановые реплеи War Thunder, публикует результаты боёв в
Discord и web-интерфейсе, а также сохраняет нормализованный датасет боёв.
Ручной AI-анализ этого датасета — отдельная необязательная и платная операция.

Основной поток данных:

```text
warthunder.com / CDN -> parsers -> items -> WRPL ingest
  -> battles / players / kills / chat -> Discord + web API + PNG/heatmaps
```

## Источники истины

Перед изменением поведения сверяйся в таком порядке: текущий код и схема БД,
затем `AGENTS.md`. Это единственное основное руководство по репозиторию;
не создавай параллельные файлы с дублирующими инструкциями. Пользовательские
настройки документируются в `.env.example`, план производительности — в
`PERFORMANCE_PLAN.md`.

Актуальные факты, которые важнее устаревших фрагментов документации:

- Минимальный Node.js — **22.15.0**, не 22.5: проект использует
  `zstdDecompressSync`.
- Активны три источника: `wt-replays`, `wt-clans` и `wt-players`;
  `wt-cookies.ts` — общий cookie jar, а не самостоятельный `ParserSource`.
- `wt-replays` опрашивается каждые 20 секунд. Константы `MAX_CATCHUP_PAGES` в
  коде нет: плановый догон вызывает `collectFreshReplays()` без `maxPages` и без
  `sinceTs`, поэтому единственный ранний выход — первая страница, на которой
  встретился уже сохранённый бой. На пустой или сброшенной таблице он не
  срабатывает никогда, и обход идёт до конца архива (AUDIT.md H5). Явный предел
  страниц есть только в `src/parsers/backfill.ts`.
- `wt-players` опрашивается каждые 30 минут, проходит `WT_PLAYER_NAMES`
  последовательно и запрашивает только первую страницу Replay API.
- Разовый backfill уже реализован в `src/parsers/backfill.ts`; по умолчанию он
  добирает три дня и оставляет разбор `.wrpl` ingest-воркеру.
- `data/battles/` — ограниченный LRU-кэш, а не вечное хранилище. Источник
  правды — нормализованные таблицы и `events_blob` в SQLite; материалы старых
  боёв восстанавливаются без реплея, а `/battle` читает summary без blob.
- CPU-пул находится в `src/workers/`: auto-размер учитывает доступные CPU,
  свободную RAM и заданные резервы. Очередь ограничена количеством задач и
  суммой transferable bytes, интерактивный потребитель повышает приоритет уже
  общей фоновой сборки, а параллельный ingest не занимает все готовые слоты. Timeout
  выполнения завершает и заменяет worker; timeout/переполнение очереди не
  расходуют попытки ingest и автоанонса.
- Модули связаны не только через БД: bot/web/WRPL напрямую импортируют DB API и
  друг друга. Замена синхронной SQLite на async Postgres затронет вызывающий
  код, а не только `src/db/`.
- Команда `/battle`, ingest, автоанонс и `wt-clans` являются частью текущего
  продукта.
- POST `/api/voice/refresh` защищён на уровне маршрута:
  `voiceRefreshRateLimitMs = 5000` отдаёт 429 с `Retry-After`, а параллельные
  запросы переиспользуют уже идущий `refreshVoice()` (`src/web/routes/api.ts`),
  поэтому полный snapshot Discord/SQLite делается не чаще раза в 5 секунд; это нужно учитывать при
  rate limiting и защите web-интерфейса.

## Среда и установка

- Нужен Node.js **>= 22.15.0**: `node:sqlite` появился раньше, но используемый
  `zstdDecompressSync` доступен только начиная с 22.15.0.
- Менеджер пакетов — npm; lock-файл `package-lock.json` должен оставаться
  согласованным с `package.json`.
- Для чистой установки используй `npm ci`, для обычной разработки — уже
  установленный `node_modules`, если зависимости не менялись.
- `.env` уже является локальным файлом и исключён из Git. Шаблон —
  `.env.example`. Никогда не печатай и не копируй в tracked-файлы значения
  токенов, cookie или API-ключей.

Переменные окружения:

- `TOKEN` — обязательный Discord bot token. Сейчас `src/config.ts` требует его
  при любом импорте config, поэтому он фактически нужен и CLI-скриптам.
- `CLIENT_ID`, `GUILD_ID` — регистрация slash-команд.
- `PORT`, `DB_PATH` — веб-порт и SQLite.
- `WT_COOKIE` — чувствительная сессия warthunder.com для `wt-replays` и
  `wt-players`.
- `WT_BROWSER_ENABLED`, `WT_BROWSER_HEADLESS`, `WT_BROWSER_TIMEOUT_MS`,
  `WT_BROWSER_PROFILE_DIR`, `WT_BROWSER_POOL_SIZE`, `WT_BROWSER_CDP_PORT` и
  `WT_BROWSER_EXECUTABLE` — транспорт warthunder.com через установленный Edge.
  Это не аварийный recovery, а основной путь: Cloudflare отклоняет прямые
  запросы из Node. Отдельный Node-cookie jar не создаётся, Edge хранит
  нативный профиль в указанном каталоге.
- `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL`, `WT_CLAN_TAG` — фильтры Discord
  и автоанонса.
- `WT_PLAYER_STATS_ENABLED` — включает ленивое получение account-статистики
  локально известных игроков со страницы профиля warthunder.com; replay-
  статистика из SQLite доступна и при `false`.
- `STATSHARK_PLAYER_STATS_ENABLED` — включает второй ленивый account-snapshot
  StatShark для identity с известным числовым WT user id. Источник использует
  общий Edge/CDP-пул и по умолчанию выключен.
- `WT_PLAYER_NAMES` — список WT-ников через запятую для периодического сбора
  HTML-профилей, режимной статистики и identity из Replay API.
- `WT_BATTLE_CACHE_MB`, `WT_BATTLE_CACHE_ENABLED`, `WT_GAME_DIR` — лимит,
  повторное использование кэша изображений и путь к игре.
- `WT_HEATMAP_AIR_AUTO_ZOOM`, `WT_HEATMAP_AIR_SHOW_GROUND_MAP`,
  `WT_HEATMAP_AIR_SHOW_AIRFIELDS`, `WT_HEATMAP_AIR_SHOW_SPAWNS`,
  `WT_HEATMAP_AIR_PADDING_PERCENT` — отображение авиационной карты.
- `WT_WORKER_THREADS` — `auto` (по умолчанию) либо явное число CPU workers;
  `WT_WORKER_RESERVE_CPUS`, `WT_WORKER_MEMORY_RESERVE_MB` и
  `WT_WORKER_ESTIMATED_MB` управляют автоматическим CPU/RAM-бюджетом.
  Жёсткий лимит пула — **8** (`MAX_CONFIGURABLE_WORKERS`, `src/workers/pool.ts:98`),
  но расчёт размера в `src/runtime-options.ts:122` его не учитывает: auto-режим
  ограничен только числом CPU и свободной RAM, а явное значение — только числом
  CPU (`runtime-options.ts:124`). `const pool = new CpuWorkerPool()`
  (`src/workers/pool.ts:595`) выполняется на верхнем уровне модуля, поэтому на
  машине с ≥10 логическими ядрами и достаточной свободной RAM конструктор
  бросает `Число CPU workers должно быть целым от 1 до 8` прямо на ESM-импорте —
  падает любой вход, который тянет `src/workers/pool.ts`. На таких машинах
  задавай `WT_WORKER_THREADS` явно числом 1..8 (или подними
  `WT_WORKER_RESERVE_CPUS`); значение >8 крашится так же, как auto.
- `WT_WORKER_BACKGROUND_RESERVE`, `WT_INGEST_CONCURRENCY` и
  `WT_WORKER_MAX_OLD_SPACE_MB` — резерв интерактивных slots, параллельность
  backlog ingest и V8 old-space одного worker.
- `ANTHROPIC_API_KEY` — только для `npm run analyze`; вызовы платные.

При добавлении новой переменной одновременно обновляй `src/config.ts`,
`.env.example` и этот файл. Реальные значения из `.env` не переноси.

### Первичная настройка

1. Установить Node.js **>= 22.15.0** и зависимости через `npm ci`.
2. Скопировать `.env.example` в локальный `.env`, заполнить как минимум
   `TOKEN` и `CLIENT_ID`; `GUILD_ID` нужен для guild-scoped slash-команд.
3. Регистрировать команды через `npm run deploy:commands` только после
   изменения их схемы и с явного разрешения пользователя: команда изменяет
   состояние Discord.
4. При стандартном `PORT=3000` локальный dashboard доступен на
   `http://localhost:3000`; основные проверки — `/health`, `/api/stats`,
   `/api/items` и `/api/voice`.

## Команды

```bash
npm run build             # обязательная статическая проверка TypeScript
npm run verify:player-stats # SQLite smoke replay/identity/snapshots
npm run verify:player-board # SQLite/render smoke постоянного табло игроков
npm run verify:player-board-voice # smoke voice-снимка и входа/выхода из канала
npm run verify:player-stats-provider # fixture-smoke provider, TTL и stale fallback
npm run verify:player-stats-api # Fastify inject smoke API/dashboard/rate limit
npm run verify:site-db    # EXPLAIN QUERY PLAN всех запросов SITE_SQL (без SCAN больших таблиц)
npm run verify:site-api   # Fastify inject smoke read-модели сайта (/api/players|clans|battles|vehicles)
npm run verify:player-stats-live # живой профиль warthunder.com → нормализация → SQLite (нужна сеть)
npm run verify:statshark-live # живой StatShark → Turnstile в Edge → нормализация (нужна сеть)
npm run verify:wt-transport # живой транспорт warthunder.com: прогрев и три профиля
npm test                  # оффлайн node:test по всем *.test.ts
npm run verify:workers    # безопасный source-smoke CPU pool + Resvg
npm run verify:workers:dist # тот же smoke после build, из dist
npm run benchmark:workers -- data/replays/<sid> [--render] [--kind=heatmap-air] [--json=data/benchmarks/result.json] # локальный WRPL/PNG без сети/БД
npm run build:web         # сборка SPA сайта (frontend/ → frontend/dist, раздаётся на /app)
npm run dev:web           # Vite dev-сервер SPA с proxy /api на :3000
npm run dev               # живой бот + web + parsers, watch-режим
npm run dev:bot           # то же без фонового разбора и автоанонса боёв
npm start                 # запуск dist/index.js
npm run start:bot         # запуск dist без фонового разбора и автоанонса боёв
npm run deploy:commands   # изменяет slash-команды в Discord
npm run battle -- <id>    # бой; дополнительные флаги: --image --media --json
npm run backfill -- 3     # сетевой добор боёв и запись в БД
npm run site              # сайт на реальной data/wtbot.db без бота/парсеров (порт 3210)
npm run analyze -- 3      # платные запросы к Anthropic и запись анализов
npm run capture:map       # снимок карты из локального API игры (localhost:8111) в data/maps
npm run benchmark:replay  # оффлайн-бенчмарк скачивания/разбора реплеев (локальный HTTP-стаб, --expose-gc)
npm run benchmark:voice   # бенчмарк voice-API на временной SQLite
```

Линтера и CI нет, а юнит-тесты есть: `npm test` — `tsx --test "src/**/*.test.ts"`.
**Набор красный уже в HEAD: `tests 44 / pass 41 / fail 3`** —
`src/wrpl/render-heatmap.test.ts:538`, `:677` и
`src/wrpl/render-battle-log.test.ts:76` (устаревшие ассерты на литеральный hex
палитры и на `font-family`). Это известное состояние, а не твоя регрессия, но и
не повод игнорировать падения: сверяй список упавших тестов до и после
изменения, число падений не должно вырасти.
`src/wrpl/render-heatmap.spec.ts` не запускается (`package.json:17` глобит
только `*.test.ts`) и не тайпчекается (`tsconfig.json:49` исключает
`**/*.spec.ts`) — это единственное покрытие `mergeNearbyCamps`,
`routeStrokeParts` и `segmentIntersection`. Правя их, запускай файл вручную:
`npx tsx --test src/wrpl/render-heatmap.spec.ts`. Минимальная проверка любого изменения —
`npm run build`; изменений worker-пула/WRPL/рендера — ещё
`npm run verify:workers` и `npm run verify:workers:dist`. Для web/DB
предпочитай изолированный smoke-тест через Fastify `inject()` и SQLite
`:memory:`.

Если пользователь явно разрешил живой запуск, рецепт из
`.claude/skills/verify/SKILL.md` такой:

1. Запустить `npm run dev` и дождаться Discord ready/web listen.
2. Проверить `GET /health` -> `{ "ok": true }`.
3. Проверить `/api/stats`, `/api/items?limit=3` и `/api/voice`.
4. В логах смотреть успешный вход Discord, результаты парсеров и отсутствие
   повторной записи неизменившихся items.
5. Slash-команды регистрировать отдельно через `npm run deploy:commands` и
   только после изменения их схемы.

На Windows после остановки watch-процесса проверь, не остался ли дочерний Node
на порту 3000. `ExperimentalWarning: SQLite` на поддерживаемой версии Node —
ожидаемое предупреждение.

Не запускай `dev`, `start`, `deploy:commands`, `backfill` или `analyze` только
ради проверки без явного запроса пользователя: они обращаются к внешним
сервисам, меняют локальную БД, могут расходовать API-бюджет или отправлять
реальные сообщения. Если `WT_BATTLES_CHANNEL` задан, а `WT_CLAN_TAG` пуст,
автоанонсер публикует бои всех кланов.

## Структура

- `src/index.ts` — порядок запуска и graceful shutdown.
- `src/config.ts` — централизованная конфигурация окружения.
- `src/db/index.ts` — схема, миграции и весь SQL; ORM нет.
- `src/bot/` — Discord client, voice tracker, announcer и slash-команды.
- `src/web/` — Fastify API и встроенный HTML-дашборд.
- `src/parsers/` — scheduler, `wt-replays`, `wt-clans`, `wt-players`
  (`wt-player.ts`), cookie jar, backfill.
- `src/wrpl/` — загрузка, бинарный разбор, ingest, assets и рендер боя.
- `src/workers/` — типизированный CPU pool, wire-протокол и worker entry.
- `src/analysis/` — ручные CLI для боя и Claude-анализа.
- `src/player-stats/` — внешняя статистика игроков: провайдеры
  (`official-profile`, `statshark`), нормализаторы, снапшоты и
  `PlayerStatsCoordinator`; поднимается в `src/index.ts` до Discord-клиента.
- `data/` — рабочая БД, cookie, реплеи и восстанавливаемые кэши.

Модули взаимодействуют через DB-функции, но границы пока не строгие: bot,
web и WRPL-код напрямую импортируют `src/db/index.ts`. SQLite API синхронный;
переход на Postgres потребует также распространить `async` по вызывающему коду.
Важнее для повседневной работы другое: `node:sqlite` синхронна, поэтому
**каждый** запрос блокирует event loop целиком — вместе с Discord-heartbeat,
voice-трекером и Fastify. Один тяжёлый SELECT = зависший бот. Для любого нового
или изменённого SQL прогоняй `EXPLAIN QUERY PLAN`; `SCAN battles` недопустим:
таблица держит `events_blob` и весит ~2.3 ГБ. Известный пример —
`WHERE session_id = ? OR session_hex = ?` (`src/db/index.ts:3038`, `:3111`,
`:3147`): у `session_hex` нет индекса, SQLite не оптимизирует такой `OR`, и
открытие боя по hex стоит ~62 с на холодном кэше (замер в `AUDIT.md`). Не
копируй этот шаблон.
В worker передавай только structured-clone-совместимые данные и точные
transferable `ArrayBuffer`; Discord/Fastify/SQLite handles туда передавать
нельзя.

Порядок старта в `src/index.ts`: инициализация SQLite -> Discord client ->
publisher `playerboard` -> voice tracker -> Fastify -> parser scheduler -> ingest
worker. Автоанонсер запускается по Discord `ClientReady`. При shutdown сначала запрещается новая
работа parser/ingest/Fastify/Discord/voice, затем всему producer-drain
(включая Fastify request и voice refresh) даётся до 10 секунд, уничтожается
Discord client, закрывается CPU pool и последней — БД. Не закрывай pool до
начала остановки производителей worker-задач; общая верхняя граница drain
нужна для SIGTERM.

## Сбор данных и ingest

- `wt-replays` и `wt-players` требуют cookie залогиненной сессии
  warthunder.com. Анонимный Replay API может вернуть HTTP 200 с пустым
  списком, поэтому пустой результат не доказывает исправность авторизации.
- Сессия скользящая: `wt-cookies.ts` поглощает `Set-Cookie`, а актуальное
  состояние хранит в `data/wt-cookies.json`. На диске хранится SHA-256 seed,
  а не вторая копия `WT_COOKIE`; запись атомарная и защищена межпроцессным
  lock для одновременного bot/backfill. User-Agent должен соответствовать
  браузеру, из которого взята cookie. При включённом browser-транспорте бот
  дополнительно раз в 30 минут продлевает сессию через Edge и синхронизирует
  актуальные cookies в общий jar; после ошибки повторяет попытку через 5 минут.
  Edge хранит нативное состояние браузера (включая clearance) в
  `WT_BROWSER_PROFILE_DIR`; auth-cookie синхронизируются с общим
  `data/wt-cookies.json`.

- Транспорт warthunder.com (`wt-browser.ts`, `wt-request.ts`) построен на
  замерах, которые важно не «оптимизировать» обратно:
  - прямой `fetch()` из Node получает `403 cf-mitigated: challenge` даже со
    свежим `cf_clearance` — клиренс привязан к TLS-отпечатку браузера, поэтому
    режим определяется одной пробой и перепроверяется раз в 6 часов, а не перед
    каждым запросом;
  - Edge, поднятый Playwright-ом (`launchPersistentContext`), имеет
    `navigator.webdriver === true` и проверку не проходит **никогда** — браузер
    запускается обычным `spawn` и подключается по CDP;
  - `--headless=new` тоже не проходит проверку, поэтому «скрытый» режим — это
    обычное окно за пределами экрана (`--window-position=-32000,-32000`);
  - после прохождения проверки `fetch()` внутри страницы отдаёт ответ за
    0.4–0.9 с, поэтому HTML берётся in-page запросом, а не навигацией;
  - проверка проходится автоматически за 5–9 с; если не удалось, окно
    возвращается на экран для ручного прохождения. CAPTCHA не обходится.
  - бинарные части `.wrpl` качаются с CDN обычным `fetch()` и через браузер
    идти не должны: тело страницы декодируется как текст.
  Живая проверка: `npm run verify:wt-transport`.
- Сбор инкрементальный: `hasItem(source, sessionId)` прекращает обход после
  первой страницы, на которой встретился уже сохранённый бой
  (`wt-replays.ts:196`), а не на первой известной записи. Постраничной паузы
  400 мс нет: все запросы к warthunder.com идут через `fetchWtResponse()`
  (`wt-request.ts`), который занимает слот в общей последовательной очереди с
  глобальным интервалом `REQUEST_INTERVAL_MS = 1_500` мс на весь процесс — один
  на все источники сразу, поэтому длинный обход `wt-replays` голодит
  `wt-players`. Новый код, ходящий на warthunder.com, обязан идти через
  `fetchWtResponse()` / `waitForRequestSlot()`, а не звать `fetch()` напрямую:
  иначе он обходит и интервал, и обработку `Retry-After`, и выбор
  direct/browser-транспорта. Исключение — исторический `wt-clans.ts` со своим
  `fetch` и паузой 400 мс; повторять этот паттерн не нужно.
  Scheduler использует `running`-guard, поэтому длинный catch-up не должен
  накладываться на следующий тик.
- Части реплея доступны на CDN примерно две недели. Новые items обрабатываются
  первыми; большой пропуск закрывай `npm run backfill -- <days>`, пока части
  ещё существуют.
- Ingest раз в 20 секунд берёт до двух волн рассчитанной параллельности,
  разносит старты CDN-загрузок на 500 мс и вызывает `loadBattleData()`
  (`parse-battle` выполняется в CPU worker). Независимые бои идут параллельно,
  но синхронные `saveBattle()` выполняются main thread последовательно и заполняют
  `battles`, `battle_players`, `battle_kills`, `battle_chat`. Состояние живёт
  в `battle_ingest`: `ok`, `error`, `expired`, `no_parts`. Переполнение,
  startup-сбой и queue timeout CPU scheduler откладывают бой без увеличения
  `attempts`; ошибка уже выполнявшегося parser и одиночная задача больше
  лимита transferable bytes считаются обычной попыткой.
- После успешного ingest части конкретной сессии удаляются из replay-cache:
  нормализованные строки и gzip `events_blob` уже позволяют восстановить бой.

`items` сохраняются пачкой в транзакции. Уникальность —
`UNIQUE(source, external_id)`, изменение определяется SHA-256 от title+JSON.
Не ломай это свойство при добавлении источников или backfill.

## Формат WRPL и материалы боя

Весь бинарный вход (`.wrpl`-части с CDN, BLK, vromfs, ECS-пакеты) — это
**недоверенные удалённые данные** (`replay-cache.ts:190` тянет части обычным
`fetch()`), схемы у них нет. Поэтому в `bit-reader.ts`, `packet-stream.ts`,
`lz4.ts`, `ecs.ts`, `gm-sync.ts` и `replay-events.ts` bounds-check обязателен, а
не по желанию: `src[i]!` и `arr[i]!` — только компайл-тайм, в runtime дают
`undefined`, а дальше NaN, который проходит мимо всех guard-сравнений.
Действующие дыры, которые нельзя повторять в новом коде: `readBits`
(`bit-reader.ts:35`) считает границу 32-битным `>>`, поэтому при `bits >= 2**31`
проверка проходит и вместо `EofError` возвращается пустой буфер, а `bitOffset`
уезжает вперёд; `readCompressed` (`bit-reader.ts:85`) без потолка сдвига
накапливает `Infinity`; `deserializeIdFields32` (`packet-stream.ts:140`)
зацикливается навсегда при маске >= 2**32. Сейчас всё это сдерживает только
таймаут CPU-пула (45/90/180 с, `pool.ts:85-89`) с последующим `terminate()` —
ещё одна причина не переносить бинарный разбор на main thread. Проверяй длины и
диапазоны до арифметики, а не после.

- Заголовок `.wrpl` имеет фиксированные поля; results-BLK обычно находится в
  последней части. BLK поддерживает FAT/FAT_ZSTD.
- Пакетный поток начинается после `1234 + settingsBlkSize`, части логически
  конкатенируются. `replay-events.ts` извлекает слоты, убийства, повреждения,
  чат, награды/победителя и траектории.
- ECS связывает uid сущности с моделью и игроком. Авиация приходит из flight
  model packets, наземная техника — через GMSync с delta/XOR/RLE. MPI-id могут
  меняться после патчей игры; если на свежих реплеях исчезли траектории,
  сравнивай сигнатуры с актуальным `WrplReplayParser` и обновляй тестовые
  fixtures/документацию.
- `loadBattleData()` асинхронно скачивает replay, передаёт точные
  `ArrayBuffer` в `parse-battle`, а worker разбирает WRPL, округляет
  координаты, готовит DB-строки и gzip blob. `reconstructBattleSummary()`
  не читает `events_blob`; media передаёт сжатый blob прямо worker-у.
- Источник для media сначала восстанавливается из БД и только затем, если это
  невозможно, загружается с CDN. Параллельные сборки одной session
  дедуплицируются; интерактивный join повышает приоритет активных
  worker-зависимостей.
- Интерактивный запрос вызывает `buildBattleMediaKind()` и worker-задачу
  `render-media-kind`, поэтому строится только выбранный log/chat/heatmap.
  `buildBattleMedia()` и `render-media` остаются полным bundle для фонового
  прогрева и CLI: log, chat и шесть обычных heatmap. Вариант 2x строится
  отдельно задачей `render-heatmap`, не пересобирая обычный bundle.
- `render-battle.ts` строит основную SVG-таблицу; `render-battle-log.ts` —
  хронологию; `render-heatmap.ts` — ground/air trajectories, смерти, зоны и
  стоянки. Общая и две командные карты режима используют одну
  `PreparedHeatmapScene`; SVG builders чистые, а `@resvg/resvg-js` создаётся
  только в worker.
- Победитель отсутствует в results-BLK и берётся из разобранных событий/БД.
  Реальные имена анонимизированных игроков восстанавливаются по `userId` из
  metadata сайта; не сопоставляй их только по display name.

Семантика локальных данных и кэшей:

- `data/wtbot.db` — источник правды и датасет.
- `data/replays/<sid>/` — временные части `.wrpl`, ленивый TTL-кэш.
- `data/battles/` — ограниченный `WT_BATTLE_CACHE_MB` LRU готовых PNG/TXT и
  meta; файлы восстановимы из БД. Каждый атомарно записанный артефакт
  перечисляется в `meta.artifacts`, а meta публикуется последней как commit
  marker. Eviction удаляет весь session-bundle, начиная с meta.
- `WT_BATTLE_CACHE_ENABLED=true` разрешает повторную выдачу сохранённых
  артефактов и обновляет их LRU-время. При `false` каждый запрос рендерится
  заново, но новый результат всё равно сохраняется в `data/battles/`.
- `data/missions/` — JSON миссий и импортов для battleArea/зон; имя включает
  хэш полного относительного пути, а parse/deep scan выполняет worker.
- `data/maps/` — tactical maps нужного режима из wt-tools; чужой режим нельзя
  подставлять, потому что на изображении уже нанесены зоны/spawn points.
- `data/unit-icons/`, `data/weapons.json` — силуэты и типы ГСН.
- `data/ecshashes.json` — словарь ECS; после несовместимого патча игры его
  может потребоваться обновить.
- `data/wt-vehicles.json` — собранный из War-Thunder-Datamine словарь техники.
- `data/fonts/symbols_skyquake.ttf` — игровой шрифт украшений клан-тегов;
  без него используются Unicode-замены.

## Discord, web и рейтинги

- Новая slash-команда: файл в `src/bot/commands/`, регистрация в
  `commands/index.ts`, затем явный `npm run deploy:commands`.
- `/battle` и автоанонсер используют общий `renderBattlePost()`; кнопки
  `battle:*` маршрутизируются в `bot/index.ts`. Chat/log/heatmaps отвечают
  ephemeral, replay открывается ссылкой.
- Автоанонсер хранит per-item попытки в `announce_state`, а baseline — в
  `bot_state`. При первом старте история не публикуется. Фильтр `WT_CLAN_TAG`
  применяется только к выводу; сбор датасета остаётся полным.
- `/playerboard setup` сохраняет канал и id одного редактируемого сообщения в
  SQLite. Publisher показывает только игроков текущего voice-снимка сервера,
  обновляет сообщение сразу после входа/выхода/перехода между каналами и только
  при изменении хэша. Свежие `wt-players` догружаются лениво через общую
  последовательную очередь; компактные снимки сохраняются для дельты за 24 часа.
- Voice tracker берёт WT-ник из display name до первой `(`, хранит текущий
  snapshot в `voice_presence`, а `/api/voice` объединяет его с локальными
  battle/rating данными. Пустой `WT_VOICE_CHANNELS` означает все каналы.
- `wt-clans` обновляет словарь clan tag -> clan name примерно каждые 12 часов.
  `clan-info.ts` запрашивает страницу клана с cooldown и пишет снимки рейтинга;
  дельта появляется со второго снимка конкретного игрока.
- `saveClanRatingSnapshots` дополнительно ведёт `clan_roster` — текущий состав
  тега по последнему обходу (пустой список состав не трогает). Суммы, дельты и
  история ПКР на сайте считаются только по текущему составу; тег без строк
  ростера (до первого обхода после миграции) читается без фильтра.
- Dashboard — одна HTML-строка в `pages.ts`; пользовательские данные вставляй
  через DOM `textContent`, не через `innerHTML`.
- `/api/player-stats` принимает только точный полный ник или стабильный WT user
  id уже известного локальным replay/voice/rating данным игрока. Внешний запрос
  каждого включённого source выполняется своей однослотовой lazy-очередью,
  кэшируется на 24 часа и защищён schema validation и локальным rate limit;
  основной источник остаётся в `account`, все источники доступны в
  `accountSources`, а account и replay coverage не суммируются в одну выборку.
- StatShark запрашивается только по стабильному числовому WT user id через
  обычный Edge, запущенный `wt-browser.ts`, и использует штатный Turnstile
  страницы. Токен остаётся в `localStorage` origin-а и не попадает в Node,
  SQLite, env или логи; `/analytics/api/send` блокируется. Сохраняются профиль,
  vehicle/leaderboard history и только используемая игроком часть глобального
  `getVehicleinfo`; текущие массивы `Vehicles` нормализуются отдельно, а
  history diff не прибавляется к ним повторно.
- Account-статистика приходит со страницы профиля warthunder.com
  (`providers/official-profile.ts`). Правила, которые нельзя нарушать:
  - страница отдаёт четыре блока (общий, авиация, наземка, флот) × три режима;
    `wt-profile-stats.ts` забирает все, `parseStatistics` в `wt-player.ts`
    по-прежнему читает только общий блок и остаётся для старого источника items;
  - «Air/Ground/Naval battles» — это **выходы на задания** (в русской локали
    «Выходы на задания»), поэтому они пишутся в `respawns`, а не в `battles`;
    складывать ветки в общее число боёв нельзя (у активного игрока сумма веток
    заметно больше: в одном бою он и летает, и ездит);
  - `battles` есть только у общей строки; сводная строка `(null, null, null)` —
    сумма трёх режимов, по ней считается account win rate;
  - длительность приходит строкой (`4d 10h`, `1.9 M`, `1ч 52мин`); «M/м» — это
    месяц, «m/мин» — минуты. Месяц считается за 30 дней, год за 365: точнее
    источник не даёт, он сам округляет до двух значащих цифр;
  - `N/A` остаётся `NULL`, а не нулём; поражения выводятся как
    `battles − victories`, потому что сайт так же считает свой win rate;
  - в `raw_json` кладутся извлечённые строки, а не HTML: страница меняется при
    каждой загрузке, и дедупликация по `content_hash` иначе не работает;
  - `player_external_vehicles` остаётся пустым — публичный профиль не публикует
    статистику по отдельным машинам.

## Ручной AI-анализ

- `npm run analyze -- <limit>` запускается только вручную и только с явного
  запроса: он использует платный `ANTHROPIC_API_KEY` и записывает результаты в
  БД.
- `getUnanalyzedItems()` выбирает записи без анализа, а `saveAnalysis()`
  сохраняет результат. `analyses.item_id` имеет ограничение `UNIQUE`, поэтому
  для одного item должна существовать не более чем одна запись анализа.
- Результаты анализа доступны через item-запросы; автоматический вызов модели
  в parser/ingest не добавляй.

## Как расширять проект

Новый parser source должен экспортировать `ParserSource` с уникальным `name`,
`intervalMs` и async `run()`, возвращающим `{summary, items?}`. Каждый item —
`{externalId, title, data}`. Добавь source в `src/parsers/sources/index.ts` и
проверь повторный запуск: неизменившиеся записи должны попасть в `unchanged`.

Новая web-функция оформляется маршрутом в `src/web/routes/` и, если нужны
runtime-зависимости, через явный `WebDeps`, а не скрытый глобальный singleton.
Для нового DB-доступа добавляй типизированную функцию в `src/db/index.ts`, не
встраивай SQL в bot/web/parser.

## Конвенции кода

- Проект ESM (`"type": "module"`): в TypeScript-импортах указывай расширение
  `.js`.
- Соблюдай строгий `tsconfig`: не ослабляй проверки и не добавляй `any` без
  доказанной необходимости.
- Комментарии, пользовательские сообщения, логи и документация — по-русски.
- SQL держи в `src/db/index.ts`; запросы должны быть параметризованы, пакетные
  записи — в транзакции.
- Сохраняй дедупликацию по `(source, external_id)` и `content_hash`.
- Не выполняй тяжёлый sync-разбор, большие JSON, компрессию, base64 изображений
  или Resvg вне `src/workers/entry.ts`.
  Discord-кнопки всё равно должны делать ранний `deferReply`.
- Все внешние `fetch` должны иметь timeout, ограничение размера ответа и
  проверку формата до помещения в постоянный кэш.
- Для новых фоновых задач обязателен guard от наложения запусков и обработка
  rejection у `void`-promise/таймеров.

## Безопасность и данные

- Не читай и не показывай значения `.env` без прямой необходимости; для
  диагностики выводи только имена ключей и состояния `set/empty`.
- `data/wt-cookies.json` содержит действующие cookie открытым текстом.
- `data/wtbot.db` содержит Discord ID, голосовое присутствие, игроков и чат
  боёв. Не удаляй, не пересоздавай и не публикуй её.
- `data/replays`, `data/battles`, карты и assets велики, но восстанавливаемы.
  Не очищай их без явного запроса; перед удалением покажи точный объём и цель.
- Все пути `data/*` зависят от текущего рабочего каталога. Для сервиса задавай
  фиксированный `WorkingDirectory`.
- Web сейчас слушает `0.0.0.0` и не имеет auth. Не выставляй порт наружу без
  reverse proxy/auth; новые API валидируй схемами и ограничивай rate/limit.

## Лицензирование

`package.json` заявляет ISC, но ряд файлов `src/wrpl/*` помечен как порт кода
AGPL-3.0 из `wrpl-inspector`; корневого `LICENSE` пока нет. Не публикуй релиз и
не меняй лицензию механически, пока происхождение кода, атрибуция и требования
AGPL не будут согласованы владельцем проекта.
Часть GMSync-декодера основана на `WrplReplayParser` под BSD-3-Clause; при
переносе или переписывании этого кода сохраняй происхождение и атрибуцию.

## Работа с Git и готовность изменения

- Рабочее дерево может содержать незакоммиченные пользовательские изменения;
  не откатывай и не форматируй несвязанные файлы.
- `data/`, `.env`, `dist/`, `node_modules/` и `.idea/` не коммитятся.
- ВАЖНО: правило `data/` в `.gitignore` матчит только каталог, файлы-соседи под
  него не попадают. Сейчас в корне лежит untracked `data.rar` (~1.2 ГБ, архив
  того самого `data/`): `git check-ignore data.rar` ничего не находит, в
  `git status` он висит как `?? data.rar`. Никогда не делай `git add -A` или
  `git add .` — добавляй только конкретные файлы своего изменения. Перед
  коммитом смотри `git status --porcelain -uall` на крупные untracked-файлы и
  не добавляй в индекс архивы и дампы (`*.rar`, `*.zip`, `*.7z`, `.env.*.local`).
- Перед сдачей изменения: запусти `npm run build` и `npm test`, проверь
  `git diff`, убедись, что секреты не попали в tracked-файлы, и перечисли
  непройденные runtime-проверки. Живой запуск не является обязательным, если он
  имеет внешние побочные эффекты.
- На HEAD `npm run build` зелёный, а `npm test` падает ровно тремя известными
  тестами — это не твоя регрессия, они чинятся отдельной задачей:
  `src/wrpl/render-heatmap.test.ts:538` и `src/wrpl/render-heatmap.test.ts:677`
  (оба ждут `stroke="#f04a50"`) и `src/wrpl/render-battle-log.test.ts:76`
  (ждёт `font-family="symbols_skyquake"`). Любое другое падение `npm test`
  считай регрессией своего изменения и чини до сдачи.
