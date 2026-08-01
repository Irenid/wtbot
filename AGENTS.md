# AGENTS.md

Инструкции для работы с репозиторием `wtbot`.

## 1. Приоритеты и границы задачи

- Источник истины о поведении: текущий код и схема SQLite.
- Источник истины о командах и окружении: `package.json`, `src/config.ts`,
  `src/runtime-options.ts` и `.env.example`.
- Этот файл фиксирует устойчивые архитектурные, эксплуатационные и безопасные
  контракты. Специализированные детали производительности находятся в
  `PERFORMANCE_PLAN.md`.
- `MASTER_PLAN.md`, `AUDIT.md` и `IMPROVEMENT_PLAN.md` являются датированными
  снимками. Не считай их текущим статусом без повторной сверки с кодом.
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
transport/cookie refresh, parsers, ingest. Shutdown сначала запрещает новую
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
  `WEB_HOST=127.0.0.1`; для non-loopback `WEB_TOKEN` обязателен.
- `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL`, `WT_CLAN_TAG`: Discord filters.
  Если задан канал боёв, а clan tag пуст, автоанонс охватывает все кланы.

### Доступ к War Thunder

- `WT_COOKIE`: чувствительная сессия warthunder.com для `wt-replays` и
  `wt-players`.
- `WT_BROWSER_*`: основной транспорт warthunder.com через установленный Edge.
  Default `WT_BROWSER_ENABLED=true`; прямой Node fetch блокируется Cloudflare.
- `WT_PLAYER_NAMES`: WT-ники для периодического сбора Replay API и HTML-профиля.
- `WT_COMPANION_COOKIE`: отдельная сессия `companion-app.warthunder.com`; не
  смешивай её с `WT_COOKIE`.

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
  не доказан. Измерения и rollback gates см. в `PERFORMANCE_PLAN.md`.

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
  `SCAN battles` недопустим: таблица содержит большие `events_blob`.
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
- `wt-clans`: примерно каждые 12 часов.

Scheduler запускает sources сразу, не допускает overlapping run одного source,
хранит parse result отдельно по source и применяет exponential backoff до
30 минут. Parser history для file-backed DB пишет worker task.

Контракты доступа:

- `wt-replays` и `wt-players` требуют авторизованную cookie. HTTP 200 с пустым
  списком не доказывает исправность сессии.
- Общий jar: `data/wt-cookies.json`. Он содержит действующие cookies открытым
  текстом, обновляется атомарно и защищён межпроцессным lock. User-Agent должен
  соответствовать браузеру, из которого взята cookie.
- Все запросы к warthunder.com идут через `fetchWtResponse()` или
  `waitForRequestSlot()`: одна последовательная очередь процесса, интервал
  1500 мс, `Retry-After` и выбор direct/browser transport. Не вызывай прямой
  `fetch()` для HTML/API сайта.
- Edge запускается обычным process и подключается по CDP. Persistent Playwright
  context и настоящий headless Cloudflare не проходят. Hidden mode использует
  окно вне экрана. CAPTCHA автоматически не обходится.
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
commit replay-cache конкретной сессии удаляется, потому что строки и gzip
`events_blob` позволяют восстановить бой.

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
конкатенируются. ECS связывает entity UID с моделью и игроком; aircraft tracks
приходят из flight-model packets, ground tracks через GMSync delta/XOR/RLE.
MPI IDs могут меняться после патчей игры, поэтому исчезновение траекторий на
свежих replay требует сверки с актуальным parser и обновления fixtures.

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
- Winner приходит из events/DB, не из results BLK. Анонимизированные имена
  восстанавливаются по `userId`, не только по display name.

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

## 8. Discord, web, рейтинги и player stats

- Новая slash-команда: файл в `src/bot/commands/`, регистрация в
  `commands/index.ts`, затем отдельный `npm run deploy:commands` только с явного
  разрешения пользователя.
- `/battle` и announcer используют общий `renderBattlePost()`; кнопки
  `battle:*` маршрутизируются в `src/bot/index.ts`. Chat/log/heatmaps ephemeral.
- Announcer хранит attempts/message state per item в `announce_state`, baseline
  в `bot_state`. Первый старт не публикует историю. Для одиночного нового боя
  может отправляться preliminary message и заменяться полным post после commit;
  bulk catch-up не создаёт поток preliminary сообщений.
- `WT_CLAN_TAG` фильтрует только публикацию, не сбор датасета.
- `/playerboard setup` хранит канал и одно редактируемое message id в SQLite.
  Publisher показывает текущий voice snapshot и пишет publication state через
  worker task только при изменении hash.
- Voice tracker берёт WT nick из display name до первой `(`. Пустой
  `WT_VOICE_CHANNELS` означает все voice channels.
- POST `/api/voice/refresh` имеет route limit 5000 мс, `Retry-After` и
  single-flight `refreshVoice()`.
- `wt-clans` обновляет tag -> clan name. `clan_roster` отражает последний
  непустой roster; rating sums/deltas/history фильтруются по текущему roster.
- `CLAN_SEASON_SCHEDULES` использует UTC интервалы `[startsAt, endsAt)`.
  Изменение существующего seeded schedule требует reconciliation или data
  migration, а не ручного исправления рабочей SQLite.
- Legacy dashboard `/` остаётся HTML в `src/web/routes/pages.ts`; вставляй
  пользовательские данные через DOM `textContent`, не `innerHTML`. SPA `/app`
  доступен только при наличии `frontend/dist`.
- Новый web route размещай в `src/web/routes/`; runtime dependencies передавай
  через явный `WebDeps`, не скрытый global singleton. API должен иметь schema,
  bounded limits и подходящий rate limit.

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
  `player_external_vehicles`.
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
- Все `data/*` зависят от working directory; для сервиса задавай фиксированный
  `WorkingDirectory`.
- Web по умолчанию loopback. Не открывай порт наружу без reverse proxy/auth;
  non-loopback требует bearer token и CSRF-защиту POST.

## 10. Команды и проверка

Полный список scripts находится в `package.json`. Основные offline gates:

```bash
npm run build
npm test
npm run verify:workers
npm run verify:workers:dist
npm run verify:benchmark-corpus
npm run verify:site-db
npm run verify:site-api
npm run verify:player-stats
npm run verify:player-stats-provider
npm run verify:player-stats-api
npm run verify:player-board
npm run verify:player-board-voice
npm run build:web
```

Выбирай проверки по затронутой подсистеме, затем перед сдачей запускай
`npm run build` и `npm test`. Для worker/WRPL/render дополнительно обязательны
source/dist worker smokes и fixed corpus. Для DB/site проверяй `verify:site-db`
и соответствующий Fastify inject smoke. Для frontend запускай `build:web`.

`src/wrpl/render-heatmap.spec.ts` не входит в `npm test` и исключён из
`tsconfig`. При изменении `mergeNearbyCamps`, `routeStrokeParts` или
`segmentIntersection` запускай отдельно:

```bash
npx tsx --test src/wrpl/render-heatmap.spec.ts
```

В репозитории нет отдельного lint script и CI gate. Зафиксированный baseline на
**2026-08-01**: `npm run build` проходит, `npm test` даёт **143 pass, 0 fail**.
Если tests добавлены или удалены, сообщи новый count; любое новое падение
считай регрессией.

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
`/health`, `/api/stats`, `/api/items?limit=3`, `/api/voice`, parser/ingest logs и
отсутствие повторной записи unchanged items. `benchmark:performance-soak`
принудительно очищает `WT_BATTLES_CHANNEL`, но всё равно использует сеть и БД.
На Windows после watch-run проверь дочерние Node processes и порт 3000.
`ExperimentalWarning: SQLite` на поддерживаемой Node version ожидаем.

## 11. Лицензирование

`package.json` заявляет ISC, но часть `src/wrpl/*` является портом AGPL-3.0
`wrpl-inspector`; корневого `LICENSE` нет. Не публикуй release и не меняй
license механически до решения владельца по происхождению, attribution и AGPL.
Часть GMSync decoder основана на BSD-3-Clause `WrplReplayParser`; сохраняй
происхождение и attribution при переносе или переписывании.

## 12. Git и готовность изменения

- Считай untracked files пользовательской работой. Не удаляй, не перемещай и не
  перезаписывай их без явного запроса.
- `data/`, `.env`, `dist/`, `node_modules/`, `.idea/`, archives и локальные
  backups не должны попадать в commit.
- Не используй `git add -A` или `git add .`; добавляй только конкретные файлы.
- Перед commit смотри `git status --porcelain -uall`, `git diff --cached` и
  проверяй staged diff на secrets, DB, cookies, dumps и generated artifacts.
- `frontend/tsconfig.tsbuildinfo` уже tracked исторически. Не включай build drift
  в тематический commit; удаление из index оформляется отдельно.
- Перед сдачей: validators должны пройти, `git diff --check` должен быть чистым,
  итоговый diff должен соответствовать только запросу пользователя. Перечисли
  runtime/live проверки, которые сознательно не запускались.