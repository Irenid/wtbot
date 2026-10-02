# AGENTS.md

Инструкции для работы с репозиторием `wtbot`.

## 1. Приоритеты и границы задачи

- Используй все доступные ресурсы. Всё что можешь. Ищи информацию везде. Используй все мощности системы. НЕ ОГРАНИЧИВАЙ СЕБЯ. Используй всё.
- Источник истины о поведении: текущий код и схема SQLite.
- Источник истины о командах и окружении: `package.json`, `src/config.ts`,
  `src/runtime-options.ts` и `.env.example`.
- Этот файл фиксирует устойчивые архитектурные, эксплуатационные и безопасные
  контракты. Специализированные детали производительности находятся в
  `docs/performance.md`.
- Документация: `README.md` (запуск), этот файл (контракты), `ROADMAP.md`
  (единственный список открытых задач), `docs/` (замеры и заметки),
  `LICENSES/` (тексты лицензий портированного кода). Новые планы и аудиты
  не заводи отдельными файлами в корне: открытые пункты — в `ROADMAP.md`,
  закрытые оттуда удаляются.
- Рабочее дерево может содержать пользовательские изменения. Не откатывай, не
  форматируй и не включай в свою работу несвязанные файлы.
- Перед изменением найди затронутые файлы, функции и их вызовы. После изменения
  оцени влияние на соседние подсистемы. Не выполняй посторонний рефакторинг.
- Исследуй репозиторий целевым поиском, а не рекурсивным чтением всех файлов.
  Используй доступные в текущем окружении инструменты, не полагайся на
  конкретный MCP или shell-wrapper как на обязательную зависимость.

## 2. Проект и архитектура

`wtbot` - модульный монолит на TypeScript. Один Node.js-процесс обслуживает
Discord, Fastify, parser scheduler и координацию ingest. Ограниченный пул
`worker_threads` выполняет тяжёлый WRPL-разбор, zlib/zstd/gzip, Resvg, часть
геометрии и доказанно блокирующие SQLite-записи. Основная точка входа:
`src/index.ts`, основное хранилище: синхронная `node:sqlite` в
`src/db/index.ts`.

Поток данных:

```text
warthunder.com / CDN -> parser sources -> items -> staged WRPL ingest
  -> battles / players / kills / chat -> Discord + web API + media
```

Ключевые каталоги:

- `src/index.ts`: startup, readiness и graceful shutdown.
- `src/config.ts`, `src/runtime-options.ts`: env и ресурсный план.
- `src/db/index.ts`: bootstrap, миграции и весь SQL; ORM нет.
- `src/bot/`: Discord client, voice tracker, player board, announcer, команды.
- `src/web/`: Fastify API, legacy dashboard `/`, опциональный SPA `/app`.
- `src/parsers/`: scheduler, sources, cookies, browser transport и backfill.
- `src/wrpl/`: replay download, бинарный parser, ingest, assets и media.
- `src/workers/`: типизированный pool, wire-протокол и worker entry.
- `src/player-stats/`: внешние account-провайдеры и coordinator.
- `src/analysis/`: ручные CLI для боя, проверок и платного AI-анализа.
- `frontend/`: React/Vite SPA.
- `data/`: рабочая БД, cookies и восстанавливаемые runtime-кэши.

Модули связаны напрямую через DB API, поэтому переход с sync SQLite на async
хранилище затронет вызывающий код, а не только `src/db/`.

Startup: ранние signal/fatal handlers, SQLite и компактный warmup, player stats,
Discord, player board, voice tracker, Fastify, фоновый SQLite warmup, WT
cookie refresh (браузер поднимается по требованию), parsers, ingest. Shutdown сначала запрещает новую
работу и даёт producers до 10 секунд на drain, затем закрывает browser, Discord,
CPU pool и последней SQLite. Не закрывай pool до остановки producers worker-задач.

### Параллелизм и максимальная производительность

- Все независимые I/O-операции запускай параллельно. Если размер входа
  ограничен конфигурацией или малой константой, используй `Promise.all`;
  для динамических или недоверенных списков используй worker-loop с явным
  concurrency cap, byte budget, timeout и отменой.
- Не пиши последовательный `await` в цикле по умолчанию. Последовательность
  допустима только при зависимости результатов, обязательном порядке,
  rate limit, lock, retry/backoff, short-circuit поиске или общем resource
  budget; причину сохраняй рядом с циклом в коде.
- CPU-heavy работу выполняй параллельно только через текущий bounded
  `worker_threads` pool. `Promise.all` не делает CPU-код многопоточным и не
  должен переносить тяжёлую синхронную работу на main thread.
- Не создавай неограниченный fan-out. Параллелизм обязан учитывать caps
  `WT_WORKER_THREADS`, `WT_INGEST_CONCURRENCY`, browser pool, Discord/API rate
  limits, SQLite write pressure и replay process byte budget.
- Сохраняй явную сериализацию для SQLite-транзакций и write queue, общей
  очереди запросов warthunder.com, пагинации со stop conditions, retry-циклов,
  commit-marker публикации и ordered Discord flows.
- Для нового параллельного пути добавляй тест, подтверждающий одновременный
  старт независимых операций, ограничение concurrency и корректный partial
  failure/fallback.

## 3. Среда, секреты и конфигурация

- Требуется Node.js **>= 22.15.0** из-за `zstdDecompressSync`.
- Менеджер пакетов: npm. При чистой установке используй `npm ci`; не меняй
  `package-lock.json`, если зависимости не менялись.
- `.env` локальный и исключён из Git. Полный каталог переменных с defaults и
  комментариями находится в `.env.example`.
- Не читай и не показывай значения `.env` без прямой необходимости. Для
  диагностики выводи только имя ключа и состояние `set/empty`.

Основные группы env:

### Core, Discord и web

- `TOKEN` обязателен для основного процесса и CLI, которые импортируют
  `src/config.ts` (`battle`, `analyze`, `backfill`, `deploy:commands`).
  Автономные CLI вроде `db:backup` не должны искусственно требовать token.
- `CLIENT_ID`, `GUILD_ID`: регистрация slash-команд.
- `DB_PATH`, `WTBOT_ALLOW_NEW_DB`: путь SQLite и явное разрешение создать новую
  БД. Default `WTBOT_ALLOW_NEW_DB=false`.
- `PORT`, `WEB_HOST`, `WEB_TOKEN`: web endpoint. Default
  `WEB_HOST=127.0.0.1`; loopback принимает только loopback `Host` (DNS
  rebinding). Для non-loopback (в Docker всегда `0.0.0.0`) `WEB_TOKEN`
  обязателен: Bearer для API-клиентов или пароль HTTP Basic для браузера.
- `WEB_TRUST_PROXY`: доверенные reverse proxy для `X-Forwarded-For`
  (`false`/`true`/список IP-CIDR). Числовой hop count Fastify 5.12 не
  поддерживает.
- `WTBOT_API_URL`, `WTBOT_API_TOKEN`: только dev-прокси Vite
  (`frontend/vite.config.ts`), бот их не читает. Направляют `/api` на боевой
  сервер и добавляют Bearer; в клиентский бандл токен попадать не должен.
- `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL`, `WT_CLAN_TAG`: Discord filters.
  Если задан канал боёв, а clan tag пуст, автоанонс охватывает все кланы
  (~1300 боёв в сутки). `WT_ANNOUNCE_MAX_AGE_HOURS` (default 2): бои старше
  не публикуются, а помечаются решёнными — после простоя бота канал не
  заваливается историей.

### Доступ к War Thunder

- `WT_COOKIE`: чувствительная сессия warthunder.com для `wt-replays` и
  `wt-players`.
- `WT_BROWSER_*`: браузер Edge (Windows) или Edge/Chrome/Chromium (Linux) для
  адресов warthunder.com, которые Cloudflare не пропускает прямым запросом.
  Default `WT_BROWSER_ENABLED=true`. `WT_BROWSER_NO_SANDBOX=true` только в Docker.
- `WT_VNC_PASSWORD`: Docker, VNC к Xvfb-дисплею браузера для ручной проверки.
- `WT_REPLAY_HOSTS`: необязательный allowlist хостов CDN частей реплеев
  (`src/wrpl/replay-url-policy.ts`); структурная SSRF-защита действует всегда.
- `WT_PLAYER_NAMES`: WT-ники для периодического сбора Replay API и HTML-профиля.
- `WT_COMPANION_COOKIE`: отдельная сессия `companion-app.warthunder.com`; не
  смешивай её с `WT_COOKIE`.

### Эксплуатация и бэкап

- Боевой запуск — Docker на Linux (`Dockerfile`, `docker-compose.yml`,
  `docker/entrypoint.sh`): Chromium под Xvfb, процесс от `node`, данные в
  томе `./data`, `restart: unless-stopped`. Windows — разработка и тесты.
- `WTBOT_BACKUP_TIME`, `WTBOT_BACKUP_DIR`, `WTBOT_BACKUP_KEEP`, `TZ`:
  ежедневный `db-backup-schedule` (сервис `backup` в compose).
- Lock-файлы (process lock, cookie jar, backup) обязаны переживать
  перезапуск контейнера: PID нового процесса обычно совпадает с упавшим, поэтому
  lock с нашим PID и чужим `ownerToken` считается оставшимся от прошлого запуска.

### Player stats

- `WT_PLAYER_STATS_ENABLED=true`: lazy account snapshot публичного профиля.
- `WT_COMPANION_PROFILE_ENABLED=false`: официальный companion snapshot.
- `STATSHARK_PLAYER_STATS_ENABLED=false`: StatShark snapshot только для
  identity с известным числовым WT user id.

### Workers, ingest и replay memory

- `WT_WORKER_THREADS=auto`; auto учитывает CPU, RAM и резервы. Жёсткий cap CPU
  pool: **8**. Default оценка одного worker: **320 МиБ**.
- `WT_WORKER_BACKGROUND_RESERVE`, `WT_WORKER_MAX_OLD_SPACE_MB`: интерактивный
  резерв и old-space одного worker.
- `WT_INGEST_CONCURRENCY`: end-to-end ingest concurrency, cap **32**. Значение
  выше размера pool перекрывает CDN I/O, но увеличивает удержание replay в RAM.
- `WT_INGEST_ADAPTIVE_ENABLED=true`: AIMD admission снижает concurrency при
  429/retry/5xx, replay-budget pressure и SQLite queue pressure.
- `WT_INGEST_PIPELINE_ENABLED=true`: bounded staged pipeline download -> ready
  queue -> worker parse. `false` включает legacy runner как rollback.
- `WT_REPLAY_PROCESS_BUDGET_MB`: общий hard limit активных replay-буферов.
  Auto резервирует память replay до расчёта worker count; диапазон 128-8192 МиБ.
- `WT_REPLAY_EXACT_RESERVATION_ENABLED=false`: экспериментальная reservation по
  проверенному cache size или **1× Content-Length** для identity body; иначе
  используется worst-case 96 МиБ. Default остаётся false, пока live RSS plateau
  не доказан. Измерения и rollback gates см. в `docs/performance.md`.

### Media и платные операции

- `WT_BATTLE_CACHE_MB`, `WT_BATTLE_CACHE_ENABLED`, `WT_GAME_DIR`: media cache и
  локальные игровые assets.
- `WT_HEATMAP_AIR_*`: параметры авиационной карты; полный список в
  `.env.example`.
- `ANTHROPIC_API_KEY`: используется только ручным `npm run analyze`.

При добавлении env одновременно обновляй `src/config.ts` или
`src/runtime-options.ts`, `.env.example` и при необходимости этот файл. Реальные
значения не переноси в tracked-файлы.

## 4. SQLite и модель данных

`node:sqlite` синхронна: любой запрос на main thread блокирует Discord heartbeat,
voice tracker и Fastify. Делай запросы короткими, индексированными и
параметризованными.

Обязательные контракты:

- SQL находится в типизированных функциях `src/db/index.ts`, а не внутри
  bot/web/parser. Batch writes выполняются в транзакциях.
- Для нового или изменённого тяжёлого SELECT запускай `EXPLAIN QUERY PLAN`.
  С v17 у планировщика есть статистика (`ANALYZE`, дальше `PRAGMA optimize`):
  план нового запроса или индекса проверяй и на копии боевой базы, а не
  только на `:memory:`. Анализ, замеры и решение по PostgreSQL —
  `docs/database.md`.
- Блоб событий боя живёт в `battle_events` и читается только по ключу одного
  боя (`SCAN battle_events` недопустим). `battles` компактна и
  кластеризована по `session_id` (`WITHOUT ROWID`). Большие значения
  (блобы, JSON больше ~1 КиБ) не клади в часто читаемые строки: такая строка
  занимает свою страницу, а колонки после неё читаются через overflow-цепочку.
- Каждый индекс `battle_players` — ~16 лишних записей (игроков боя) на
  каждый сохранённый бой. Индекс добавляй только под запрос, план которого
  его использует; неиспользуемые индексы удалены в v17.
- Для `WHERE session_id = ? OR session_hex = ?` план должен использовать
  multi-index OR и `idx_battles_session_hex`, а не полный scan.
- `getIngestStats().pending` и `getPendingBattleItems()` должны использовать
  одинаковый retryable predicate. Агрегат pending не должен читать
  `events_blob`.
- `initDb()` содержит idempotent bootstrap чистой БД, а `runDbMigrations()`
  версионирует legacy DDL/backfill через `PRAGMA user_version`. Изменение
  таблицы, индекса или constraint добавляй новой migration version и одновременно
  обновляй bootstrap. Не скрывай migration errors широким `catch`.
- База с `user_version > DB_SCHEMA_VERSION` не открывается.
- Подключения: WAL, `synchronous = NORMAL` (коммит не ждёт fsync, сбой
  питания откатывает последние транзакции, но не портит базу), mmap 1 ГиБ,
  `journal_size_limit`, `temp_store = MEMORY` — только после VACUUM. Новая
  база создаётся с `auto_vacuum = INCREMENTAL`; VACUUM на старте — только у
  базы без него (один раз, минуты на гигабайтах, бот в это время не в сети),
  если свободно больше 20% и 256 МиБ. Дальше место возвращает
  `db/maintenance.ts` в worker-задачах (`db-maintenance`,
  `recompress-events-blobs`), а не main thread: перевод блобов событий в
  колоночный формат с возвратом освободившихся страниц после каждой пачки,
  раз в несколько часов `PRAGMA optimize(0x10002)` (у свежего подключения
  без флага 0x10000 он не видит ни одной таблицы) и `incremental_vacuum`
  порциями; останавливается до CPU pool.
- Записанные бои чинит фоновый проход `repair-battle-events`
  (`db/maintenance.ts`): правила `events-repair.ts` — те же, что применяет
  ingest, — колоночный формат и пустые `slot`, `title`, `air_unit_count`,
  `chat_count` из событий. Блоб и строки убийств и чата заменяются вместе и
  только если блоб не изменился с чтения. Новое правило починки — следующая
  `REPAIR_VERSION`, а не ручная правка рабочей базы; то, что чинится SQL или
  повторным разбором с CDN, — миграция (пример — v18).
- Окончательный сбой повторного разбора уже записанного боя (`expired`,
  `no_parts`) оставляет статус `ok` с причиной в `error`: строки прежнего
  разбора — данные боя.
- Фоновая транзакция записи (worker, обслуживание, разовый скрипт рядом с
  ботом) — десятки миллисекунд, не больше: запись main thread ждёт чужую
  блокировку синхронно, и event loop стоит всё это время.
  `incremental_vacuum` — шагами `VACUUM_STEP_PAGES` (256 страниц) с паузой:
  одна порция в 8 192 страницы держала блокировку 1,3 с (watchdog
  2026-10-02).
- Частые file-backed записи ingest, parser history и player-board publication
  выполняются типизированными worker-задачами
  `persist-ingested-battle`, `record-parse-result` и
  `update-player-stat-board-publication`. Для `:memory:` тестов допустим sync
  fallback.
- Worker connection меняет `PRAGMA data_version`; main-thread read caches должны
  инвалидироваться через текущий data-version механизм, а не предполагать, что
  записи идут только через main connection.
- `primeKnownItemExternalIds('wt-replays')` загружает known IDs из covering
  unique index до parser scheduler. Positive cache hit не обращается к SQLite;
  miss всё равно проверяется запросом для корректности параллельного backfill.
- Поиск игроков использует индексированные `canonical_nick_search`,
  `nick_search` и `battle_players.nick_search`. Не заменяй JS `NFKC` +
  locale-neutral lowercase функцией SQLite `COLLATE NOCASE`.
- `items` сохраняются транзакционно, уникальность:
  `UNIQUE(source, external_id)`. Изменение определяется `content_hash` от
  title + JSON; сохрани это при новых sources и backfill.

`db:backup` использует `VACUUM INTO`, lock, free-space check, rotation и
read-only `quick_check`. Restore выполняй только при остановленном сервисе:
проверь backup, сохрани текущую БД как `.pre-restore`, проверь временную копию и
только затем замени `DB_PATH`.

## 5. Workers и тяжёлая работа

- В worker передавай только structured-clone-совместимые значения и точные
  transferable `ArrayBuffer`. Discord/Fastify/SQLite handles передавать нельзя.
- Не выполняй на main thread тяжёлый sync WRPL/BLK/VROMFS/ECS parsing, большие
  JSON transform, compression, base64 изображений, Resvg или доказанно долгие
  SQLite writes.
- Pool ограничен числом задач и transferable bytes, имеет приоритеты, резерв
  интерактивных slots, queue timeout, execution timeout и замену зависшего
  worker.
- Интерактивный join должен повышать приоритет уже общей фоновой зависимости,
  а не запускать дубликат работы.
- `EXEC_TIMEOUT`, queue timeout, startup/scheduling failure и queue overflow не
  должны расходовать ingest/announce attempts. Ошибка уже выполнявшегося parser
  считается обычной попыткой.
- `@resvg/resvg-js` создаётся только в worker. Discord handlers всё равно
  выполняют ранний `deferReply`/`deferUpdate`.

## 6. Parser sources и WT transport

Активные sources:

- `wt-replays`: каждые 20 секунд, плановый cap 50 страниц,
  `stopAtKnown=true`, `fetchDetails=false`; остановка на known page, последней
  неполной странице, date cutoff или cap.
- `wt-players`: каждые 30 минут, `WT_PLAYER_NAMES` последовательно, только
  первая страница Replay API.
- `wt-clans`: каждые 20 минут первые 5 страниц официального лидерборда полков
  (сотня лидеров сайта), раз в 12 часов — дальше, пока у кланов ненулевой
  рейтинг сезона (словарь «тег → имя» для claninfo), но не больше 100
  страниц: упор в предел виден в статусе источника. Рейтинг `dr_era5_hist`,
  место, состав, бои, победы, фраги, смерти, налёт, активность, регион, тип,
  дата основания, слоган и награды сезонов пишутся в `clans` с общим
  `rating_at` обхода; изменения рейтинга, боёв, побед, фрагов и смертей —
  change-point в `clan_rating_history`; сезон лидерборда — `bot_state`
  `wt-clans:season`, расхождение с форумом видно в статусе источника.
  Регион, тип, слоган и награды приходят экранированными для HTML и с
  разметкой игры (`<color=#…>`, `<b>`) — в базу идёт чистый текст; тег и имя
  не меняются (ключи боёв и claninfo). Там же профиль клана: `_id` (номер,
  не меняется вместе с тегом), описание и объявление (переносы строк
  сохраняются, до 2048 символов), условия вступления `membership_req`
  (JSON `{ranks, battles}`), приём, тег без украшений (`lastPaidTag`) и
  украшение за прошлый сезон. После обхода — ростер claninfo пяти
  лидеров, чей ростер старше суток: иначе ростер и ПКР были только у кланов
  из нарисованных боёв. Ростер claninfo пишет в `clan_roster` и роль,
  дату вступления и активность участника; незнакомое значение ячейки — NULL.
  Дата создания на самой странице claninfo неверная («01.01.1970»), берётся
  `cdate` лидерборда.
- `wt-clan-season`: каждые 6 часов читает первый пост темы форума
  `forum.warthunder.ru/raw/2509/1` (не warthunder.com, без Cloudflare, обычный
  bounded fetch) и пишет сезоны `forum-ГГГГ-ММ-ДД` в `clan_seasons`.

Scheduler запускает sources сразу, не допускает overlapping run одного source,
хранит parse result отдельно по source и применяет exponential backoff до
30 минут. Parser history для file-backed DB пишет worker task.

Контракты доступа:

- `wt-replays` и `wt-players` требуют авторизованную cookie. HTTP 200 с пустым
  списком не доказывает исправность сессии.
- Общий jar: `data/wt-cookies.json`. Он содержит действующие cookies открытым
  текстом, обновляется атомарно и защищён межпроцессным lock. Рядом с cookies
  jar хранит User-Agent браузера, выдавшего сессию: прямой запрос с ними
  представляется тем же браузером.
- Все запросы к warthunder.com идут через `fetchWtResponse()` или
  `waitForRequestSlot()`: одна последовательная очередь процесса, интервал
  1500 мс, `Retry-After`. Не вызывай прямой `fetch()` для HTML/API сайта.
- Cloudflare проверяет отдельные адреса, а не весь сайт: в октябре 2026 прямой
  запрос получал 403 `cf-mitigated: challenge` только на профиле и поиске
  игроков, а Replay API, лидерборды, claninfo и WTCS отвечали без браузера.
  Поэтому способ доступа выбирается для каждого маршрута (первые три сегмента
  пути): сначала прямой запрос, браузер — после проверки Cloudflare, прямой
  путь перепроверяется раз в 6 часов. Режимы маршрутов видны в `/api/stats`
  (`wtTransport.routes`). Сетевой сбой прямого запроса повторяется через
  браузер один раз, не меняя режим маршрута.
- Сессию WT (identity_*) ведёт jar, она нужна только Replay API. Публичный
  прямой запрос идёт без cookies и не трогает jar; cookies Cloudflare прямой
  запрос не отправляет. Браузер получает сессию из jar, только пока Replay API
  идёт через него, и тогда же сохраняет её обратно; иначе ходит анонимно:
  сервер ротирует `identity_sid`, и две живые копии одной сессии разошлись бы.
  Своя сессия браузера (вход через VNC) запоминается и берётся в jar, если
  Replay API вернёт пустой список; без неё Replay API на 6 часов уходит в
  браузер. Host-only копия рядом с доменной — прежний баг: сервер читал
  устаревший `identity_sid` и уводил на повторный вход, Replay API отдавал
  пустой список.
- Публичная страница claninfo (`clan-info.ts`) читается своим прямым `fetch`
  без cookies, но после `waitForRequestSlot()`, а 429 откладывает всю очередь.
  Если claninfo начнёт отвечать 403 с `cf-mitigated: challenge`, переведи её на
  `fetchWtResponse()`.
- Edge запускается обычным process и подключается по CDP. Persistent Playwright
  context и настоящий headless Cloudflare не проходят. Hidden mode использует
  окно вне экрана. CAPTCHA автоматически не обходится. Платформенная часть
  (пути браузера, флаги Docker, `/proc`, SingletonLock) —
  `wt-browser-platform.ts`; на Linux без `DISPLAY` браузер не запускается.
- Сетевые пробы clearance ограничены: растущая пауза 0,5→4 с и не больше
  `MAX_FAILED_CLEARANCE_PROBES` неудачных проб за попытку.
- Бинарные `.wrpl` parts скачиваются с CDN обычным bounded `fetch`; browser
  transport декодирует body как текст и для parts не подходит.
- Каждый внешний fetch обязан иметь timeout, предел response bytes и schema или
  format validation до permanent cache.
- Большой пропуск закрывай `npm run backfill -- <days>`, пока CDN parts ещё
  существуют. Backfill по умолчанию добирает три дня и оставляет WRPL parsing
  ingest worker.

Новый source экспортирует `ParserSource` с уникальным `name`, `intervalMs` и
`run(): Promise<{ summary, items? }>`, регистрируется в
`src/parsers/sources/index.ts`. Повторный запуск неизменных items должен давать
`unchanged`.

## 7. Staged ingest, WRPL и media

### Ingest

Каждый tick выбирает до `2 × concurrency` pending items, преимущественно новые,
периодически старые. При staged pipeline:

1. Producers с интервалом 500 мс скачивают replay и кладут подготовленный input
   в bounded ready queue по count и bytes.
2. До четырёх consumers передают точные buffers в `parse-battle` workers.
3. Успешные writes сериализуются и выполняются через
   `persist-ingested-battle` на отдельном worker SQLite connection.
4. Транзакция атомарно обновляет `battles`, `battle_players`, `battle_kills`,
   `battle_chat` и `battle_ingest`.
5. Passive WAL checkpoint выполняется не после каждого боя, а по cadence; при
   graceful shutdown ingest запрашивает отдельный worker checkpoint.

AIMD admission и process byte budget ограничивают давление на CDN, pool, SQLite
и RAM. Budget timeout откладывает item без увеличения attempts. После успешного
commit replay-cache конкретной сессии удаляется, потому что строки и блоб
событий (`battle_events`, `events-codec.ts`) позволяют восстановить бой.
Блоб — колоночный формат: траектории (99% событий) лежат массивами разностей
и сжаты zstd-19, ~20 КиБ на бой. Запись проверяет восстановление байт в байт
и иначе пишет zstd-JSON; читаются и прежние zstd-JSON и gzip. Читай события
через `decodeEventsPayload`/`decodeEventsBlob`, а `inflateEventsBlob` (JSON
текстом) — только для хэшей и перевода форматов. Образ без колоночного
формата такие блобы не прочитает (откат — `docs/database.md`).

Replay API показывает часть боёв (~2%) ещё до их конца: `partsCount` и
`endTime` такой записи ранние, а бот запоминает запись при первом обнаружении
и больше её не перечитывает. Поэтому:

- перед скачиванием ingest ищет на CDN части после известных
  (`withUnlistedReplayParts`: GET одного байта, до первой 404). 429 проба
  повторяет, как скачивание; иная ошибка — сбой попытки, а не конец списка:
  иначе старый бой с неполным списком сразу стал бы `expired`;
- 404/410 части у боя моложе часа (от `endTime` записи) значит «ещё не
  выложена»;
- разбор с промежуточными итогами (из части 0001, ~95 с, без статуса) не
  записывается — реплей ещё не дописан. Бой без исхода по времени пишет
  финальные итоги тоже без статуса; их отличает время не меньше длительности
  по записи сайта (`hasFinalReplayResults`).

В обоих случаях бой ждёт повтор в памяти (`ReplayPartWaitList`, пауза 1→3 мин)
без расхода attempts, `expired` — только у боя старше этого окна. Признак
обрезанного боя в данных — `battles.status` NULL при `team_won = 0` и
длительности ~95 с. Раньше любой 404 сразу давал `expired` (терялось ~2% боёв,
миграция v11 вернула их в очередь), а без поиска хвоста они записывались
обрезанными (v12–v14 вернули их на переразбор).

### Недоверенный бинарный вход

Все `.wrpl`, BLK, VROMFS и ECS packets являются недоверенными удалёнными
данными без схемы. В `bit-reader.ts`, `packet-stream.ts`, `lz4.ts`, `ecs.ts`,
`gm-sync.ts`, `replay-events.ts` и новых decoders:

- проверяй lengths, counts, offsets и ranges до арифметики и allocation;
- сохраняй bounds-check для varint, LZ4, ECS, FAT BLK, VROMFS, XOR/RLE и packet
  fields;
- помни, что TypeScript non-null assertion не является runtime guard;
- задавай output limits для zlib/zstd/gzip и отдельный worker execution timeout;
- после изменения parser проверяй fixed corpus hash/outcome/data contract.

Пакетный поток начинается после `1234 + settingsBlkSize`, parts логически
конкатенируются. userId слота — знаковый int64 (`BigInt.asIntN`): у ботов он
отрицательный, как в results-BLK. Строки сообщений чата — с длиной-varint
(`readVarLenStr`): однобайтовая длина обрезала сообщения длиннее 127 байт.
Чат реплея подписан анонимными именами (`fakeName` записи Replay API) —
ingest заменяет их настоящими по `fakeNamesFromItem` до записи. Сжатие определяется по магии (`packetStreamCodec`): до 2.59 —
zlib, с 2.59 (заголовок `101404`) — zstd. С той же версии construct-сообщение
ECS содержит байт формата перед счётчиком компонентов
(`ECS_CONSTRUCT_PREFIX_VERSION`). ECS связывает entity UID с моделью и игроком;
aircraft tracks приходят из flight-model packets, ground tracks через GMSync
delta/XOR/RLE.

Патч игры ломает разбор молча: results-BLK (игроки, очки) читается, а
события — нет. Поэтому:

- часть, которую не удалось распаковать ни одним кодеком, — ошибка разбора
  боя, а не пустой бой;
- сбой одной ECS-сущности не обрывает пакет: граница блока известна, остальные
  сущности (среди них техника игроков) разбираются, ошибка уходит в
  `events.errors`;
- признак поломки в данных — `kill_count = 0` и пустые траектории у боёв, где
  в `battle_players` есть фраги; сверяй по `game_version`;
- реплей новой версии игры добавляй в `benchmarks/replay-corpus.json`;
- уже записанные неверные бои переразбирай миграцией, снимающей их статус в
  `battle_ingest` (пример — v6/v7), пока части ещё лежат на CDN (~2 недели).
  После commit ingest удаляет старые артефакты сессии в `data/battles/`.

`prepareBattleData()` скачивает и резервирует parts, `parsePreparedBattleData()`
отправляет их в worker. Legacy `loadBattleData()` сохраняется для rollback и
интерактивных путей. `reconstructBattleSummary()` не читает `events_blob`; media
передаёт compressed blob worker-у.

### Media и cache

- Media сначала восстанавливается из SQLite, затем при необходимости с CDN.
- Параллельные сборки одной session дедуплицируются; interactive join повышает
  priority общей сборки.
- `buildBattleMediaKind()` + `render-media-kind` строит только выбранный
  log/chat/heatmap. `buildBattleMedia()` + `render-media` оставляет полный
  bundle для background warmup и CLI. 2x heatmap строится отдельно.
- Ground/air/team heatmaps переиспользуют `PreparedHeatmapScene`; SVG builders
  остаются чистыми.
- Подложка сцены плеера на сайте — та же, что у наземной хитмапы: снимок
  тактической карты режима миссии (wt-tools, ровно battleArea; качается при
  сборке сцены, только если battleArea известна), иначе локальная карта
  уровня. `/api/battles/:key/map.png` читает карту только с диска.
- Winner приходит из events/DB, не из results BLK. Анонимизированные имена
  восстанавливаются по `userId`, не только по display name.
- Порядок шрифтов Resvg (`src/workers/render-fonts.ts`) — порядок запасного
  поиска: UI-шрифт без box-drawing (Linux — Noto Sans из `fonts-noto-core`,
  Windows — Segoe UI), шрифт игры, письменности, символьный запас. UI-шрифт
  с box-drawing (DejaVu) рисует рамки клан-тегов вместо глифов игры.
  `map-icons.ttf` в базу Resvg не передаётся: он подменяет цифры и буквы
  иконками.

Данные и cache:

- `data/wtbot.db`: источник правды и датасет.
- `data/replays/<sid>/`: временный TTL cache replay parts.
- `data/battles/`: ограниченный `WT_BATTLE_CACHE_MB` LRU готовых artifacts.
  `*-meta.json` публикуется последним как commit marker; eviction удаляет весь
  session bundle.
- `WT_BATTLE_CACHE_ENABLED=false` запрещает reuse, но новый render всё равно
  сохраняется.
- `benchmarks/fixtures/replays/`: единственный постоянный fixed WRPL corpus.
- `data/missions/`, `data/maps/`, `data/unit-icons/`, `data/weapons.json`,
  `data/ecshashes.json`, `data/wt-vehicles.json`, `data/fonts/`: локальные
  assets и восстанавливаемые индексы. Не подставляй tactical map другого mode.
- `data/wt-game/ui/`: копия `fonts.vromfs.bin` и `atlases.vromfs.bin` клиента
  игры для Docker (`WT_GAME_DIR`); из атласа при каждом старте берутся флаги
  наций. Ошибка чтения флагов не роняет картинку боя: остаются свои флаги.

## 8. Discord, web, рейтинги и player stats

- Новая slash-команда: файл в `src/bot/commands/`, регистрация в
  `commands/index.ts`, затем отдельный `npm run deploy:commands` только с явного
  разрешения пользователя.
- `/battle` и announcer используют общий `renderBattlePost()`; кнопки
  `battle:*` маршрутизируются в `src/bot/index.ts`. Chat/log/heatmaps ephemeral.
- Announcer хранит attempts/message state per item в `announce_state`, baseline
  в `bot_state`. Первый старт не публикует историю; бои старше
  `WT_ANNOUNCE_MAX_AGE_HOURS` пропускаются одним запросом `skipStaleAnnounce()`
  (кроме уже отправленных preliminary). Для одиночного нового боя может
  отправляться preliminary message и заменяться полным post после commit;
  bulk catch-up не создаёт поток preliminary сообщений.
- `WT_CLAN_TAG` фильтрует только публикацию, не сбор датасета.
- `/playerboard setup` хранит канал и одно редактируемое message id в SQLite.
  Publisher показывает текущий voice snapshot и пишет publication state через
  worker task только при изменении hash.
- Voice tracker берёт WT nick из display name до первой `(`. Пустой
  `WT_VOICE_CHANNELS` означает все voice channels.
- POST `/api/voice/refresh` имеет route limit 5000 мс, `Retry-After` и
  single-flight `refreshVoice()`.
- Рейтинг, место, «за 30 дн.» и график клана на сайте — официальные, из
  лидерборда: снимки ПКР есть лишь у кланов, чьи бои бот рисовал, и сумма по
  ним теряла лидеров. Кланы свежего обхода идут раньше кланов из прежних
  обходов сезона, сумма ПКР по снимкам — только для кланов без официальных
  данных. `clan_roster` отражает последний непустой roster; ростер, ПКР
  участников и их дельты фильтруются по текущему roster.
- `CLAN_SEASON_SCHEDULES` использует UTC интервалы `[startsAt, endsAt)`.
  Изменение существующего seeded schedule требует reconciliation или data
  migration, а не ручного исправления рабочей SQLite. Новые сезоны в код не
  добавляются: их приносит `wt-clan-season` (`src/clan-season-forum.ts`).
  Пост форума недоверенный: при любой странности разбор падает целиком, forum-
  сезон со сдвинутым началом заменяет прежний, пересечение со встроенным —
  ошибка.
- Legacy dashboard `/` остаётся HTML в `src/web/routes/pages.ts`; вставляй
  пользовательские данные через DOM `textContent`, не `innerHTML`. SPA `/app`
  доступен только при наличии `frontend/dist`.
- Новый web route размещай в `src/web/routes/`; runtime dependencies передавай
  через явный `WebDeps`, не скрытый global singleton. API должен иметь schema,
  bounded limits и подходящий rate limit.

Страница игрока (`/app/players/…`) читает `/api/players/:key` (профиль, клан
игрока с ролью из ростера, источники с `account` — уровень, даты, история
кланов и ников, места в рейтингах WT) и `/api/players/:key/insights?days=`
— разбор локальных реплеев (карты, техника, кланы, напарники, оружие,
соперники, часы игры) по последним 500 боям периода. Аналитика читается в
worker-задаче `read-player-insights` со своим read-only подключением, кэш —
минута, вес в rate limit — 2. Кнопка «обновить» шлёт POST `/api/player-stats`:
источники младше суток не перечитываются.

`/api/player-stats` принимает только точный известный nick или стабильный WT
user id. Каждый включённый external source имеет однослотовую lazy queue, TTL
24 часа, stale fallback, schema validation и локальный rate limit. Replay и
account coverage не суммируются; primary snapshot находится в `account`, все
источники в `accountSources`.

Provider invariants:

- Official profile публикует общий/air/ground/naval blocks по трём modes.
  Branch `Air/Ground/Naval battles` означает respawns, не число battles.
  `battles` есть только у общей строки; aggregate account win rate считается
  по summary трёх modes.
- `N/A` остаётся `NULL`. Defeats считаются как `battles - victories`.
  Latin `M` в duration означает month, `m` означает minute; month = 30 days,
  year = 365 days согласно точности источника.
- Official `raw_json` содержит извлечённые строки, не HTML, и не создаёт
  `player_external_vehicles`. Блок «Vehicles and rewards» (техника, элитная
  техника и медали по нациям) идёт в `player_external_countries`; нет блока
  или незнакомая вёрстка — пустой список, а не ошибка snapshot.
- Companion использует отдельную official session и не зависит от Cloudflare
  transport сайта.
- StatShark запускается только по стабильному numeric user id через общий Edge.
  Turnstile token остаётся в browser `localStorage`, не попадает в Node, SQLite,
  env или logs; analytics endpoint блокируется.

`npm run analyze -- <limit>` является отдельной ручной и платной операцией.
Не добавляй автоматический model call в parser/ingest. `analyses.item_id`
уникален, поэтому на item хранится не более одного analysis.

## 9. Конвенции кода и безопасность

- Проект ESM (`"type": "module"`): в TypeScript imports используй `.js`.
- Соблюдай strict `tsconfig`; не ослабляй checks и не добавляй `any` без
  доказанной необходимости.
- Комментарии, пользовательские сообщения, logs и документация: по-русски.
- Новая фоновая задача должна иметь overlap guard и обработку rejection у
  `void` promise или timer callback.
- Не публикуй tokens, cookies, API keys, Discord IDs, battle chat или DB dumps.
- `data/wt-cookies.json` содержит активные cookies. `data/wtbot.db` содержит
  Discord IDs, voice presence, игроков и chat. Не удаляй, не пересоздавай и не
  публикуй их.
- `data/replays`, `data/battles`, maps и assets велики, но пользовательские. Не
  очищай их без явного запроса; перед удалением укажи точный path, объём и цель.
- Все `data/*` зависят от working directory: в Docker это `WORKDIR /app` с
  томом `./data`, локально — корень репозитория.
- Web по умолчанию loopback, наружу — только через reverse proxy и
  `WEB_TOKEN` (раздел 3). POST с чужим `Origin`/`Sec-Fetch-Site` отклоняется
  403 в любом режиме; запрос без этих заголовков (не браузер) проходит.
  Ответы за авторизацией не помечаются `Cache-Control: public`.

## 10. Команды и проверка

Полный список scripts находится в `package.json`. Основные offline gates:

```bash
npm run build                 # tsconfig.build.json: dist/ без тестов
npm run verify                # typecheck + npm test + все офлайн verify:* и corpus
npm run verify:workers:dist
npm run build:web
```

`npm run verify` включает `typecheck` (весь `src/`, включая тесты и
`*.spec.ts`), `npm test` (`*.test.ts` и `*.spec.ts`), `verify:workers`,
`verify:site-db`, `verify:site-api`, `verify:player-stats*`,
`verify:player-board*` и `verify:benchmark-corpus`. Отдельные скрипты можно
запускать по затронутой подсистеме.

CI (`.github/workflows/ci.yml`) выполняет те же шаги на Linux (Node 26, как в
образе) и Windows (Node 24), `npm audit` и сборку Docker-образа. Меняя `FROM
node:` в `Dockerfile`, поднимай и Node Linux-job. Dependabot присылает обновления раз в
неделю. Не добавляй в `npm test` флаг `--test-force-exit`: на Windows с Node 24
он роняет процесс тестов с fetch (libuv assert), а зависающих тестов нет.

Baseline на **2026-10-02**: `npm run build` и `npm run verify` проходят,
`npm test` даёт **297 pass, 0 fail**, corpus — 6 сценариев (включая 2.59). Если tests добавлены или удалены, сообщи
новый count; любое новое падение считай регрессией.

Команды с внешними или локальными side effects не запускай только ради smoke
без явного разрешения пользователя:

- `npm run dev`, `npm start`, `npm run dev:bot`, `npm run start:bot`;
- `npm run deploy:commands` меняет slash-команды Discord;
- `npm run backfill -- <days>` обращается к сети и пишет в БД;
- `npm run analyze -- <limit>` выполняет платные API calls;
- `npm run verify:player-stats-live`, `npm run verify:statshark-live`,
  `npm run verify:wt-transport` и `npm run benchmark:performance-soak`
  обращаются к внешним сервисам;
- `npm run battle -- <id>` может скачивать replay и строить media.

Если live run явно разрешён, дождись Discord ready и web listen, проверь
`/health`, `/api/stats` (статус каждого source), `/api/items?limit=3`,
`/api/voice`, parser/ingest logs и отсутствие повторной записи unchanged items.
Обязательно смотри строки `[ingest] бой …: убийств N, победитель …`: сплошные
«убийств 0, победитель ?» означают поломку разбора после патча игры (раздел 7).
`wt-replays` с «API вернул пустой список» — протухший `WT_COOKIE`, нужен
ручной вход на warthunder.com. Перед live run с заданным `WT_BATTLES_CHANNEL`
оцени очередь анонса: она уйдёт в настоящий канал. `benchmark:performance-soak`
принудительно очищает `WT_BATTLES_CHANNEL`, но всё равно использует сеть и БД.
На Windows после watch-run проверь дочерние Node processes и порт 3000;
фоновый процесс там штатно не остановить (`process.kill(pid, 'SIGINT')`
завершает без обработчиков) — graceful shutdown проверяется Ctrl+C в консоли
или `docker compose stop`.
`ExperimentalWarning: SQLite` на поддерживаемой Node version ожидаем.

## 11. Лицензирование

Проект распространяется по GNU AGPL-3.0-or-later (`LICENSE`, `package.json`).
Часть `src/wrpl/*` — порт AGPL-3.0 `wrpl-inspector`, GMSync decoder
(`gm-sync.ts`) основан на BSD-3-Clause `WrplReplayParser` и Dagor Engine;
происхождение указано в SPDX-заголовках файлов. BSD-3-Clause требует сохранять
уведомление и текст лицензии вместе с исходниками и сборками: тексты лежат в
`LICENSES/` и копируются в Docker-образ. Сетевые страницы (`/` и SPA)
обязаны показывать ссылку на исходный код (AGPL §13). Лицензии runtime-пакетов
и шрифта SPA — `frontend/public/THIRD_PARTY_NOTICES.txt`; при новой frontend
зависимости дополняй его.

## 12. Git и готовность изменения

- Считай untracked files пользовательской работой. Не удаляй, не перемещай и не
  перезаписывай их без явного запроса.
- `data/`, `.env`, `dist/`, `node_modules/`, `.idea/`, archives и локальные
  backups не должны попадать в commit.
- Не используй `git add -A` или `git add .`; добавляй только конкретные файлы.
- Перед commit смотри `git status --porcelain -uall`, `git diff --cached` и
  проверяй staged diff на secrets, DB, cookies, dumps и generated artifacts.
- Сообщение коммита описывает всё, что в нём есть: не прячь новый модуль или
  изменение поведения за заголовком вроде «change test timeout».
- `*.tsbuildinfo` игнорируется и не должен снова попасть в индекс.
- Перед сдачей: validators должны пройти, `git diff --check` должен быть чистым,
  итоговый diff должен соответствовать только запросу пользователя. Перечисли
  runtime/live проверки, которые сознательно не запускались.