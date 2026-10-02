# AGENTS.md

Контракты `wtbot` для агентов и разработчиков — то, чего не видно из кода
сразу. Поведение — по коду и схеме SQLite; команды и env — `package.json`,
`src/config.ts`, `src/runtime-options.ts`, `.env.example`.

## 1. Правила работы

- Используй все доступные ресурсы и мощности системы, ищи информацию везде —
  не ограничивай себя.
- Поиск — целевой (`rg`, `git grep`), не чтение всего репозитория; MCP и
  shell-wrapper не обязательны.
- Перед правкой найди затронутые функции и их вызовы, после — оцени влияние
  на соседние подсистемы. Посторонний рефакторинг не делай.
- Чужие изменения и untracked-файлы — работа пользователя: не откатывай, не
  форматируй, не удаляй, не бери в свой коммит
- Документы: `README.md` — запуск; этот файл — контракты; `ROADMAP.md` —
  единственный список открытых задач (закрытое удаляется); `docs/` — замеры и
  заметки (`performance.md`, `database.md`, `replay-data-quality.md`);
  `LICENSES/` — лицензии портированного кода; скиллы —
  `.claude/skills/verify/` (проверка, живой бот),
  `.agents/skills/monorepo-debug/` (диагностика). Новые планы и аудиты в
  корне не заводи.
- `.env` не читай и не выводи без прямой необходимости; для диагностики —
  имя ключа и `set/empty`.

Без явного разрешения пользователя нельзя:

- публиковать токены, cookies, API-ключи, Discord ID, чат боёв, дампы БД;
- удалять, пересоздавать или публиковать `data/wtbot.db` (Discord ID, голосовое
  присутствие, игроки, чат) и `data/wt-cookies.json` (живые cookies);
- чистить `data/replays`, `data/battles`, карты и assets — перед удалением
  назови путь, объём и цель;
- запускать команды с внешними эффектами (раздел 10), выкатывать и
  перезапускать бота.

## 2. Архитектура

Модульный монолит на TypeScript. Один Node.js-процесс: Discord, Fastify,
планировщик парсеров, координация ingest. Ограниченный пул `worker_threads`:
разбор WRPL, zlib/zstd/gzip, Resvg, часть геометрии, доказанно блокирующие
записи SQLite. Вход — `src/index.ts`; хранилище — синхронная `node:sqlite`,
весь SQL — в `src/db/index.ts`, без ORM. Модули связаны через этот API
напрямую: переход на асинхронное хранилище затронет вызывающих, а не только
`src/db/`.

```text
warthunder.com / CDN -> parser sources -> items -> staged WRPL ingest
  -> battles / players / kills / chat -> Discord + web API + media
```

`src/`: `index.ts` (запуск, shutdown), `config.ts` и `runtime-options.ts`
(env, план ресурсов), `db/` (bootstrap, миграции, SQL, обслуживание), `bot/`
(команды, автоанонс, voice tracker, табло), `web/` (API, дашборд `/`, SPA
`/app`), `parsers/` (планировщик, источники, cookies, браузер, backfill),
`wrpl/` (реплеи, ingest, assets, media), `workers/` (пул, протокол),
`player-stats/` (внешние провайдеры), `analysis/` (ручные CLI, smoke, платный
AI-анализ). `frontend/` — SPA на React/Vite; `data/` — база, cookies, кэши,
assets.

Запуск: проверка Discord-токена → process lock → обработчики сигналов и
фатальных ошибок → SQLite (без прогрева страниц) → player stats → Discord →
табло → voice tracker → Fastify → прогрев SQLite в worker → обновление cookies
WT (браузер — по требованию) → парсеры → ingest → обслуживание базы.
Остановка: запрет новой работы, до 10 с на drain producers, затем браузер,
Discord, CPU pool, последней — SQLite. Pool не закрывай, пока producers
worker-задач не остановлены.

### Параллелизм

- Независимый I/O — параллельно: `Promise.all`, если вход ограничен
  конфигурацией или малой константой; иначе worker-loop с явными concurrency
  cap, byte budget, timeout и отменой.
- Последовательный `await` в цикле — только при зависимости результатов,
  обязательном порядке, rate limit, lock, retry/backoff, short-circuit поиске
  или общем бюджете; причину пиши рядом с циклом.
- CPU-работа — только через пул: `Promise.all` не делает её многопоточной.
- Fan-out ограничен: `WT_WORKER_THREADS`, `WT_INGEST_CONCURRENCY`, пул браузера,
  rate limits Discord и API, давление записи SQLite, бюджет реплеев.
- Сериализованы намеренно: транзакции и очередь записи SQLite, общая очередь
  warthunder.com, пагинация со stop conditions, retry, публикация
  commit-маркера, упорядоченные потоки Discord.
- Новый параллельный путь — с тестом: одновременный старт, предел
  concurrency, частичный сбой и fallback.

## 3. Окружение и эксплуатация

- Node.js ≥ 22.15.0 (`zstdDecompressSync`); npm, установка — `npm ci`;
  `package-lock.json` меняется только вместе с зависимостями.
- `.env` локальный, вне Git; полный каталог с defaults — `.env.example`. Новая
  переменная — сразу в `src/config.ts` или `src/runtime-options.ts`,
  `.env.example` и, если это контракт, сюда. Реальных значений в tracked-файлах
  нет.

| Переменная | Контракт |
|---|---|
| `TOKEN` | нужен процессу бота и CLI, импортирующим `src/config.ts` (`battle`, `analyze`, `backfill`, `deploy:commands`); автономные CLI (`db:backup`) его не требуют |
| `CLIENT_ID`, `GUILD_ID` | регистрация slash-команд |
| `DB_PATH`, `WTBOT_ALLOW_NEW_DB=false` | новая база — только явно |
| `PORT`, `WEB_HOST=127.0.0.1`, `WEB_TOKEN` | loopback принимает только loopback `Host` (DNS rebinding); не loopback (в Docker всегда `0.0.0.0`) — только с `WEB_TOKEN`: Bearer или пароль HTTP Basic |
| `WEB_TRUST_PROXY` | `false`/`true`/список IP-CIDR для `X-Forwarded-For`; число hops Fastify 5.12 не умеет |
| `WTBOT_API_URL`, `WTBOT_API_TOKEN` | только dev-прокси Vite (`frontend/vite.config.ts`): `/api` на боевой сервер с Bearer; бот их не читает, в бандл токен не попадает |
| `WT_VOICE_CHANNELS`, `WT_BATTLES_CHANNEL`, `WT_CLAN_TAG` | пустой список голосовых — все каналы; канал боёв без тега клана — анонс всех кланов (~1 800 боёв в сутки); тег фильтрует публикацию, не сбор |
| `WT_ANNOUNCE_MAX_AGE_HOURS=2` | бои старше не публикуются, а помечаются решёнными: простой бота не заваливает канал историей |
| `WT_COOKIE` | сессия warthunder.com для `wt-replays` и `wt-players` |
| `WT_COMPANION_COOKIE` | отдельная сессия `companion-app.warthunder.com`; с `WT_COOKIE` не смешивать |
| `WT_BROWSER_*` (`ENABLED=true`) | Edge (Windows) или Edge/Chrome/Chromium (Linux) для адресов за Cloudflare; `NO_SANDBOX=true` только в Docker |
| `WT_VNC_PASSWORD` | VNC к Xvfb-дисплею браузера в Docker: ручной вход и проверка Cloudflare |
| `WT_REPLAY_HOSTS` | allowlist хостов CDN частей (`src/wrpl/replay-url-policy.ts`); структурная защита от SSRF действует и без него |
| `WT_PLAYER_NAMES` | ники для `wt-players`: Replay API и HTML-профиль |
| `WT_PLAYER_STATS_ENABLED=true`, `WT_COMPANION_PROFILE_ENABLED=false`, `STATSHARK_PLAYER_STATS_ENABLED=false` | lazy-снимки аккаунта: профиль сайта, companion, StatShark (только при известном числовом WT user id) |
| `WT_WORKER_THREADS=auto` | по CPU, RAM и резервам; предел 8, оценка 320 МиБ на worker |
| `WT_WORKER_BACKGROUND_RESERVE`, `WT_WORKER_MAX_OLD_SPACE_MB` | резерв слотов под интерактив; old-space одного worker |
| `WT_INGEST_CONCURRENCY` | предел 32; больше пула — перекрывает I/O с CDN ценой RAM под реплеи |
| `WT_INGEST_ADAPTIVE_ENABLED=true` | AIMD снижает concurrency при 429/retry/5xx и давлении бюджета реплеев или очереди SQLite |
| `WT_INGEST_PIPELINE_ENABLED=true` | staged pipeline; `false` — прежний runner (откат) |
| `WT_REPLAY_PROCESS_BUDGET_MB` | общий предел буферов реплеев, 128–8192 МиБ; auto резервирует его до расчёта числа worker |
| `WT_REPLAY_EXACT_RESERVATION_ENABLED=false` | резерв по размеру кэша или 1× `Content-Length` вместо worst-case 96 МиБ; выключен до доказанного RSS plateau (`docs/performance.md`) |
| `WT_BATTLE_CACHE_MB`, `WT_BATTLE_CACHE_ENABLED`, `WT_GAME_DIR`, `WT_HEATMAP_AIR_*` | кэш media, файлы игры, параметры авиакарты |
| `WTBOT_BACKUP_TIME`, `WTBOT_BACKUP_DIR`, `WTBOT_BACKUP_KEEP`, `TZ` | ежедневный `db-backup-schedule` (сервис `backup`) |
| `ANTHROPIC_API_KEY` | только ручной `npm run analyze` |

- Боевой запуск — Docker на Linux (`Dockerfile`, `docker-compose.yml`,
  `docker/entrypoint.sh`): Chromium под Xvfb, процесс от `node`, том `./data`,
  `restart: unless-stopped`. Разработка и тесты — Linux или Windows (CI —
  обе). Пути `data/*` — от рабочего каталога: в Docker `WORKDIR /app`, локально
  — корень репозитория. Если рабочая копия — каталог боевого compose, её
  `data/` — данные работающего бота: `npm run dev`, `battle`, backfill пишут в
  ту же базу, бот — с тем же Discord-токеном.
- Выкатка — только с разрешения. До `docker compose build` пометь работающий
  образ (`docker tag wtbot:latest wtbot:pre-<что>`): после пересоздания
  контейнера непомеченный образ пропадает. Копию базы снимай отдельным шагом и
  проверь файл до `up -d`: без неё миграция, меняющая схему, необратима. Откат —
  `docs/database.md`.
- Lock-файлы (process lock, cookie jar, backup) переживают перезапуск
  контейнера: PID нового процесса обычно совпадает с упавшим, поэтому lock с
  нашим PID и чужим `ownerToken` — от прошлого запуска.

## 4. SQLite

`node:sqlite` синхронна: запрос на main thread стопорит heartbeat Discord,
voice tracker и Fastify. Запросы — короткие, индексированные,
параметризованные. Замеры, решения и откат миграций — `docs/database.md`.

- SQL — только в типизированных функциях `src/db/index.ts`; пакетная запись —
  в транзакции.
- Новый или изменённый тяжёлый SELECT — через `EXPLAIN QUERY PLAN`, в том числе
  на копии боевой базы: с v17 у планировщика статистика (`ANALYZE`, затем
  `PRAGMA optimize`), и план на `:memory:` бывает другим.
- Блоб событий живёт в `battle_events` и читается только по ключу одного боя
  (`SCAN battle_events` недопустим); `battles` — компактная, `WITHOUT ROWID`
  по `session_id`. Большое значение (блоб, JSON > ~1 КиБ) в часто читаемой
  строке занимает свою страницу, а колонки после него читаются через
  overflow-цепочку.
- Индекс `battle_players` — ~16 записей (игроки боя) на каждый бой: добавляй
  только под запрос, чей план его использует.
- `WHERE session_id = ? OR session_hex = ?` — multi-index OR с
  `idx_battles_session_hex`, не полный scan.
- `getIngestStats().pending` и `getPendingBattleItems()` — один retryable
  predicate; агрегат pending не читает `events_blob`.
- `initDb()` — идемпотентный bootstrap чистой базы, `runDbMigrations()` —
  версии через `PRAGMA user_version`. Изменение таблицы, индекса или
  constraint — новая версия миграции и правка bootstrap; ошибки миграции не
  глушить широким `catch`. Базу с `user_version > DB_SCHEMA_VERSION` код не
  открывает: прежний образ после миграции — только с бэкапом.
- Подключение: WAL, `synchronous = NORMAL` (коммит без fsync; сбой питания
  откатывает последние транзакции, но не портит базу), mmap 1 ГиБ,
  `journal_size_limit`, `temp_store = MEMORY` после VACUUM. Новая база — с
  `auto_vacuum = INCREMENTAL`; VACUUM на старте — только у базы без него (один
  раз, минуты на гигабайты, бот не в сети) при свободных > 20% и 256 МиБ.
- Обслуживание (`db/maintenance.ts`) — в worker-задачах `db-maintenance` и
  `repair-battle-events`, не на main thread: пачка починки сразу возвращает
  освободившиеся страницы; раз в несколько часов — `PRAGMA optimize(0x10002)`
  (без флага 0x10000 свежее подключение не видит ни одной таблицы) и
  `incremental_vacuum` шагами `VACUUM_STEP_PAGES` (256 страниц) с паузой;
  останавливается до CPU pool.
- Фоновая транзакция записи (worker, обслуживание, разовый скрипт рядом с
  ботом) — десятки миллисекунд: запись main thread ждёт чужую блокировку
  синхронно, и event loop стоит. Порция `incremental_vacuum` в 8 192 страницы
  держала блокировку 1,3 с (watchdog, 2026-10-02).
- Записанные бои чинит проход `repair-battle-events`: правила
  `events-repair.ts` — те же, что у ingest; колоночный формат и пустые `slot`,
  `title`, `air_unit_count`, `chat_count` — из событий. Блоб и строки убийств
  и чата заменяются вместе и только если блоб не изменился с чтения. Новое
  правило — следующая `REPAIR_VERSION`, не ручная правка базы; то, что чинит
  SQL или разбор заново с CDN, — миграция (пример — v18).
- Окончательный сбой повторного разбора записанного боя (`expired`,
  `no_parts`) оставляет статус `ok` с причиной в `error`: строки прежнего
  разбора — данные боя.
- Частые записи в файл базы (ingest, история парсеров, публикация табло) —
  worker-задачи `persist-ingested-battle`, `record-parse-result`,
  `update-player-stat-board-publication`; у `:memory:` в тестах — sync fallback.
- Запись из worker меняет `PRAGMA data_version`: кэши чтения main thread
  сбрасываются по нему, а не в расчёте на то, что пишет только main.
- `primeKnownItemExternalIds('wt-replays')` грузит известные ID из
  покрывающего unique index до запуска парсеров: попадание — без SQLite,
  промах — запросом (корректность параллельного backfill).
- Поиск игроков — по индексированным `canonical_nick_search`, `nick_search`,
  `battle_players.nick_search`: JS `NFKC` + locale-neutral lowercase, не
  `COLLATE NOCASE`.
- `items`: запись транзакционная, `UNIQUE(source, external_id)`, изменение —
  по `content_hash` от title + JSON; новые источники и backfill его сохраняют.
- `db:backup`: `VACUUM INTO`, lock, проверка свободного места, ротация,
  read-only `quick_check`. Restore — при остановленном сервисе: проверь бэкап,
  сохрани текущую базу как `.pre-restore`, проверь временную копию, затем
  замени `DB_PATH`.

## 5. Workers

- В worker — только structured-clone значения и точные transferable
  `ArrayBuffer`; handles Discord, Fastify и SQLite не передаются.
- Не на main thread: синхронный разбор WRPL/BLK/VROMFS/ECS, большие
  JSON-преобразования, сжатие, base64 картинок, Resvg (`@resvg/resvg-js`
  создаётся только в worker), доказанно долгие записи SQLite.
- Пул: пределы числа задач и transferable bytes, приоритеты, резерв
  интерактивных слотов, таймауты очереди и выполнения, замена зависшего worker.
- Интерактивный запрос повышает приоритет уже общей фоновой задачи, а не
  запускает дубль.
- `EXEC_TIMEOUT`, таймаут очереди, сбой запуска или планирования и
  переполнение очереди не расходуют попытки ingest и анонса — кроме 3
  таймаутов подряд (`ExecTimeoutBudget`), иначе детерминированно медленная
  задача повторялась бы вечно. Ошибка уже выполнявшегося разбора — обычная
  попытка.
- Обработчики Discord всё равно сразу делают `deferReply`/`deferUpdate`.

## 6. Парсеры и доступ к warthunder.com

Источники (константы — в их файлах `src/parsers/sources/`):

- `wt-replays` — раз в 20 с, до 50 страниц (`PLANNED_REPLAYS_MAX_PAGES`),
  `stopAtKnown`, без `fetchDetails`; стоп на известной странице, последней
  неполной, дате отсечки или пределе.
- `wt-players` — раз в 30 мин, `WT_PLAYER_NAMES` по очереди, только первая
  страница Replay API.
- `wt-clans` — раз в 20 мин 5 страниц лидерборда полков (сотня лидеров), раз в
  12 ч — дальше, пока рейтинг сезона (`dr_era5_hist`) не ноль, до 100 страниц
  (упор виден в статусе). Обход пишет `clans` с общим `rating_at`, изменения
  рейтинга, боёв, побед, фрагов и смертей — change-point в
  `clan_rating_history`, сезон лидерборда — `bot_state` `wt-clans:season`
  (расхождение с форумом — в статусе). Регион, тип, слоган и награды приходят
  экранированными для HTML с разметкой игры (`<color=#…>`, `<b>`) — хранится
  чистый текст; тег и имя — как есть (ключи боёв и claninfo). Профиль: `_id`
  (не меняется со сменой тега), описание и объявление (переносы сохраняются,
  ≤ 2048 символов), `membership_req` `{ranks, battles}`, приём, тег без
  украшений `lastPaidTag`, украшение прошлого сезона. Затем — ростер claninfo
  5 лидеров с ростером старше суток (иначе ростер и ПКР были бы лишь у кланов
  из нарисованных боёв): роль, дата вступления, активность, незнакомая ячейка
  — `NULL`. Дата основания — `cdate` лидерборда: claninfo показывает
  «01.01.1970».
- `wt-clan-season` — раз в 6 ч первый пост темы
  `forum.warthunder.ru/raw/2509/1` (не warthunder.com: без Cloudflare, обычный
  bounded fetch) → сезоны `forum-ГГГГ-ММ-ДД` в `clan_seasons`.

Планировщик запускает источники сразу, не пересекает запуски одного
источника, хранит результат по источнику, backoff экспоненциальный до 30 мин;
историю разбора для файловой базы пишет worker-задача. Новый источник —
`ParserSource` с уникальным `name`, `intervalMs` и
`run(): Promise<{ summary, items? }>`, регистрация в
`src/parsers/sources/index.ts`; повтор неизменных items даёт `unchanged`.

Доступ:

- `wt-replays` и `wt-players` требуют авторизованную сессию; HTTP 200 с пустым
  списком не доказывает её исправность («API вернул пустой список» — протухший
  `WT_COOKIE`, нужен ручной вход).
- Все запросы к warthunder.com — через `fetchWtResponse()` или
  `waitForRequestSlot()`: одна очередь на процесс, интервал 1 500 мс,
  `Retry-After`. Прямой `fetch()` к HTML и API сайта запрещён.
- Cloudflare проверяет отдельные адреса: в октябре 2026 403
  `cf-mitigated: challenge` получали только профиль и поиск игроков, а Replay
  API, лидерборды, claninfo и WTCS отвечали напрямую. Поэтому транспорт — по
  маршруту (первые три сегмента пути): сначала прямой запрос, браузер — после
  проверки Cloudflare, прямой путь перепроверяется раз в 6 ч; режимы —
  `wtTransport.routes` в `/api/stats`. Сетевой сбой прямого запроса один раз
  повторяется через браузер без смены режима маршрута.
- Jar `data/wt-cookies.json`: живые cookies открытым текстом, атомарная
  запись, межпроцессный lock; рядом — User-Agent браузера, выдавшего сессию
  (прямой запрос представляется им).
- Сессию WT (`identity_*`) ведёт jar, нужна она только Replay API. Публичный
  прямой запрос идёт без cookies и jar не трогает; cookies Cloudflare прямой
  запрос не шлёт. Браузер получает сессию из jar, только пока Replay API идёт
  через него, и тогда же пишет её обратно, иначе ходит анонимно: сервер
  ротирует `identity_sid`, и две живые копии сессии разошлись бы. Своя сессия
  браузера (вход через VNC) берётся в jar, если Replay API вернул пустой
  список; без неё Replay API на 6 ч уходит в браузер. Host-only копия cookie
  рядом с доменной — прежний баг: сервер читал устаревший `identity_sid`,
  уводил на вход, и Replay API отдавал пустой список.
- claninfo (`src/wrpl/clan-info.ts`) — свой прямой `fetch` без cookies, но
  после `waitForRequestSlot()`; 429 откладывает всю очередь. Начнёт отвечать
  403 `cf-mitigated: challenge` — переведи на `fetchWtResponse()`.
- Браузер — обычный процесс и CDP: persistent context Playwright и настоящий
  headless Cloudflare не проходят; hidden mode — окно за экраном; CAPTCHA
  автоматически не решается. Платформа (пути, флаги Docker, `/proc`,
  SingletonLock) — `wt-browser-platform.ts`; на Linux без `DISPLAY` браузер не
  стартует. Пробы clearance: пауза 0,5→4 с, не больше
  `MAX_FAILED_CLEARANCE_PROBES` неудач за попытку.
- Части `.wrpl` — обычным bounded `fetch` с CDN: браузерный транспорт
  декодирует тело как текст.
- Любой внешний fetch: timeout, предел байт ответа, проверка схемы или формата
  до постоянного кэша.
- Пропуск закрывает `npm run backfill -- <days>` (по умолчанию 3 дня, разбор
  оставляет ingest), пока части лежат на CDN (~2 недели).

## 7. Ingest, WRPL и media

### Ingest

- Tick берёт до `2 × concurrency` pending items: новые, каждый 8-й проход —
  старые. Producers (раз в 500 мс) скачивают реплей в bounded ready queue (по
  числу и байтам) → до 4 consumers → worker `parse-battle` → сериализованная
  запись `persist-ingested-battle` на своём подключении: одна транзакция
  обновляет `battles`, `battle_events`, `battle_players`, `battle_kills`,
  `battle_chat`, `battle_ingest`. Passive checkpoint WAL — раз в 32 коммита
  или 60 с, при остановке — отдельной worker-задачей.
- AIMD и byte budget процесса держат нагрузку на CDN, пул, SQLite и RAM;
  таймаут бюджета откладывает item без попытки.
- После commit кэш частей сессии и её старые artifacts в `data/battles/`
  удаляются: бой восстанавливается из строк и блоба событий.
- Блоб событий (`battle_events`, `events-codec.ts`) — колоночный: траектории
  (99% событий) массивами разностей, zstd-19, ~20 КиБ на бой. Запись проверяет
  восстановление байт в байт, иначе пишет zstd-JSON; читаются и zstd-JSON, и
  gzip. Читай через `decodeEventsPayload`/`decodeEventsBlob`;
  `inflateEventsBlob` (JSON текстом) — только для хэшей и перевода форматов.
  Образ без колоночного формата эти блобы не прочитает (откат —
  `docs/database.md`).
- Replay API показывает ~2% боёв до их конца: `partsCount` и `endTime` ранние,
  а запись бот читает один раз. Поэтому перед скачиванием ingest ищет части
  после известных (`withUnlistedReplayParts`: GET одного байта до первой 404;
  429 — повтор, иная ошибка — сбой попытки, а не конец списка, иначе старый
  бой с неполным списком стал бы `expired`). 404/410 у боя моложе часа (от
  `endTime`) — «ещё не выложена». Промежуточные итоги (часть 0001, ~95 с, без
  статуса) не пишутся; финальные итоги боя без исхода по времени (тоже без
  статуса) отличает время не меньше длительности по записи
  (`hasFinalReplayResults`). Такой бой ждёт в памяти (`ReplayPartWaitList`,
  1→3 мин) без попытки; `expired` — только после этого окна. Признак
  обрезанного боя в данных — `status` NULL, `team_won = 0`, ~95 с (v11–v14
  вернули такие бои на разбор).

### Недоверенный бинарный вход

`.wrpl`, BLK, VROMFS, пакеты ECS — недоверенные данные без схемы. В
`bit-reader.ts`, `packet-stream.ts`, `lz4.ts`, `ecs.ts`, `gm-sync.ts`,
`replay-events.ts` и новых декодерах:

- длины, счётчики, смещения и диапазоны — проверить до арифметики и выделения
  памяти; bounds-check varint, LZ4, ECS, FAT BLK, VROMFS, XOR/RLE и полей
  пакетов не убирать; non-null assertion TypeScript — не runtime guard;
- у zlib/zstd/gzip — пределы вывода, у worker — таймаут выполнения;
- после правки разбора — корпус (`npm run verify:benchmark-corpus`: хэш, исход,
  контракт данных).

Формат: поток пакетов — после `1234 + settingsBlkSize`, части склеиваются
логически. Сжатие — по магии (`packetStreamCodec`): до 2.59 zlib, с 2.59
(заголовок `101404`) zstd, и construct-сообщение ECS получило байт формата
перед счётчиком компонентов (`ECS_CONSTRUCT_PREFIX_VERSION`). userId слота —
знаковый int64 (`BigInt.asIntN`, у ботов отрицательный, как в results-BLK).
Строки чата — с длиной-varint (`readVarLenStr`: однобайтовая длина обрезала
сообщения длиннее 127 байт). Чат подписан анонимными `fakeName` записи
Replay API — ingest заменяет их настоящими (`fakeNamesFromItem`) до записи.
ECS связывает UID сущности с моделью и игроком; траектории самолётов — из
пакетов flight model, наземной техники — GMSync (delta/XOR/RLE).

Патч игры ломает разбор молча — results-BLK (игроки, очки) читается, события
нет:

- часть, которую не распаковал ни один кодек, — ошибка разбора, не пустой бой;
- сбой одной ECS-сущности не обрывает пакет (граница блока известна):
  остальные, в том числе техника игроков, разбираются, ошибка — в
  `events.errors`;
- признак в данных — `kill_count = 0` и пустые траектории при фрагах в
  `battle_players`; сверяй по `game_version`;
- реплей новой версии игры — в `benchmarks/replay-corpus.json`;
- записанные неверные бои — миграцией, снимающей их статус в `battle_ingest`
  (пример — v6/v7), пока части на CDN (~2 недели).

`prepareBattleData()` скачивает и резервирует части, `parsePreparedBattleData()`
отдаёт их worker; прежний `loadBattleData()` — для отката и интерактивных
путей. `reconstructBattleSummary()` не читает `events_blob`; media передаёт
worker сжатый блоб.

### Media и кэш

- Media собирается из SQLite, с CDN — только при необходимости; параллельные
  сборки одной сессии объединяются, интерактивный запрос повышает приоритет.
- `buildBattleMediaKind()` + `render-media-kind` — только запрошенный
  лог, чат или хитмапа; `buildBattleMedia()` + `render-media` — полный набор
  для прогрева и CLI; хитмапа 2× — отдельно. Хитмапы ground/air/team
  переиспользуют `PreparedHeatmapScene`, SVG builders — чистые функции.
- Подложка сцены на сайте — как у наземной хитмапы: снимок тактической карты
  режима миссии (wt-tools, ровно battleArea; качается при сборке сцены, только
  если battleArea известна), иначе локальная карта уровня; карту другого
  режима не подставлять. `/api/battles/:key/map.png` читает карту только с
  диска.
- Победитель — из событий и базы, не из results-BLK; анонимные имена
  восстанавливаются по `userId`, не только по нику.
- Порядок шрифтов Resvg (`src/workers/render-fonts.ts`) — порядок запасного
  поиска: UI-шрифт без box-drawing (Linux — Noto Sans из `fonts-noto-core`,
  Windows — Segoe UI), шрифт игры, письменности, символы. DejaVu с
  box-drawing рисует рамки вместо глифов игры в клан-тегах; `map-icons.ttf` в
  базу Resvg не передаётся: он подменяет цифры и буквы иконками.

Данные:

- `data/wtbot.db` — источник правды и датасет;
- `data/replays/<sid>/` — TTL-кэш частей;
- `data/battles/` — LRU готовых artifacts до `WT_BATTLE_CACHE_MB`:
  `*-meta.json` публикуется последним как commit marker, вытеснение удаляет
  весь набор сессии; `WT_BATTLE_CACHE_ENABLED=false` отключает reuse, но не
  сохранение;
- `benchmarks/fixtures/replays/` — единственный постоянный корпус WRPL;
- `data/missions/`, `maps/`, `unit-icons/`, `fonts/`, `weapons.json`,
  `ecshashes.json`, `wt-vehicles.json` — assets и восстанавливаемые индексы;
- `data/wt-game/ui/` — копии `fonts.vromfs.bin` и `atlases.vromfs.bin` из
  игры для Docker (`WT_GAME_DIR`): флаги наций читаются из атласа при каждом
  старте, при сбое остаются свои флаги, картинка не падает.

## 8. Discord, сайт и статистика игроков

- Slash-команда: файл в `src/bot/commands/`, регистрация в
  `src/bot/commands/index.ts`, затем `npm run deploy:commands` — только с
  разрешения.
- `/battle` и автоанонс — общий `renderBattlePost()`; кнопки `battle:*` —
  `src/bot/index.ts`; чат, лог и хитмапы — ephemeral.
- Автоанонс: попытки и сообщение — `announce_state`, baseline — `bot_state`;
  первый старт историю не публикует; бои старше `WT_ANNOUNCE_MAX_AGE_HOURS`
  снимаются одним `skipStaleAnnounce()` (кроме начатых предварительных);
  одиночный новый бой может получить предварительное сообщение с заменой на
  полный пост после commit, массовый догон — нет.
- `/playerboard setup` хранит канал и одно редактируемое сообщение в SQLite;
  табло показывает текущий voice-снимок и пишет состояние публикации
  worker-задачей только при смене hash. Ник WT — display name до первой `(`.
- `POST /api/voice/refresh` — не чаще раза в 5 с (`Retry-After`),
  single-flight `refreshVoice()`.
- Кланы на сайте: рейтинг, место, «за 30 дн.» и график — официальные, из
  лидерборда (снимки ПКР есть лишь у кланов из нарисованных боёв, и их сумма
  теряла лидеров). Кланы свежего обхода — выше кланов из прежних обходов
  сезона; сумма ПКР по снимкам — только у кланов без официальных данных.
  `clan_roster` — последний непустой ростер; ростер, ПКР участников и их
  дельты фильтруются по нему.
- `CLAN_SEASON_SCHEDULES` — UTC `[startsAt, endsAt)`; изменение встроенного
  расписания — reconciliation или миграция данных, не ручная правка базы.
  Новые сезоны приносит `wt-clan-season` (`src/clan-season-forum.ts`), не код.
  Пост форума недоверенный: любая странность валит разбор целиком; сезон
  форума со сдвинутым началом заменяет прежний, пересечение со встроенным —
  ошибка.
- Дашборд `/` — HTML в `src/web/routes/pages.ts`: пользовательские данные —
  через `textContent`, не `innerHTML`. SPA `/app` — только при `frontend/dist`.
- Новый маршрут — в `src/web/routes/`, зависимости — через явный `WebDeps`,
  без скрытых синглтонов; у API — schema, ограниченные лимиты и rate limit.
- Web по умолчанию на loopback, наружу — только через reverse proxy и
  `WEB_TOKEN`. POST с чужим `Origin`/`Sec-Fetch-Site` — 403 в любом режиме;
  без этих заголовков (не браузер) проходит. С токеном хук `onSend` меняет
  `public` на `private` у защищённых ответов: общий кэш прокси не отдаст их
  без токена.
- Страница игрока (`/app/players/…`): `/api/players/:key` — профиль, клан с
  ролью из ростера, источники с `account` (уровень, даты, история кланов и
  ников, места в рейтингах WT); `/api/players/:key/insights?days=` — разбор
  локальных реплеев (карты, техника, кланы, напарники, оружие, соперники,
  часы) по последним 500 боям периода: worker-задача `read-player-insights` со
  своим read-only подключением, кэш 1 мин, вес в rate limit 2.
- `POST /api/player-stats` (кнопка «обновить», форма дашборда) — только
  точный известный ник или стабильный WT user id. У каждого включённого
  внешнего источника — однослотовая lazy-очередь, TTL 24 ч (младше — не
  перечитывается), stale fallback, проверка схемы, свой rate limit. Покрытие
  реплеев и аккаунта не суммируется; основной снимок — `account`, все —
  `accountSources`.

Инварианты провайдеров:

- Официальный профиль: блоки общий/air/ground/naval по трём режимам; ветки
  `Air/Ground/Naval battles` — респавны, не бои; `battles` есть только у общей
  строки; win rate аккаунта — по сумме трёх режимов.
- `N/A` → `NULL`; поражения = `battles − victories`; в длительности латинская
  `M` — месяц, `m` — минута; месяц = 30 дней, год = 365 (точность источника).
- `raw_json` официального профиля — извлечённые строки, не HTML, и
  `player_external_vehicles` он не создаёт. «Vehicles and rewards» (техника,
  элитная техника, медали по нациям) → `player_external_countries`; нет блока
  или вёрстка незнакома — пустой список, не ошибка снимка.
- Companion — своя официальная сессия, Cloudflare сайта не касается.
- StatShark — только по числовому user id через общий браузер; токен Turnstile
  остаётся в `localStorage` браузера (не в Node, SQLite, env, логах),
  analytics-endpoint блокируется.

`npm run analyze -- <limit>` — ручная платная операция; автоматических вызовов
модели в парсерах и ingest нет. `analyses.item_id` уникален: на item — не
больше одного анализа.

## 9. Код и тексты

- ESM (`"type": "module"`): импорты TypeScript — с `.js`.
- Strict `tsconfig` не ослаблять; `any` — только при доказанной необходимости.
- Комментарии, сообщения пользователю, логи, документация — по-русски;
  коммиты и PR — по-английски, без атрибуции ассистента (`Co-Authored-By`,
  «Generated with»).
- Комментарий и документ — максимум информации в минимуме текста: почему,
  контракт, предел, единицы, дата замера; код не пересказывать. Значение —
  ссылкой на константу или функцию, а не копией числа; устаревший текст
  правь или удаляй вместе с кодом.
- Новая фоновая задача — с overlap guard и обработкой rejection у `void`
  promise и callback таймера.

## 10. Команды и проверка

Офлайн-gates (полный список — `package.json`):

```bash
npm run build                 # dist/ по tsconfig.build.json, без тестов
npm run verify                # typecheck, npm test, офлайн verify:*, корпус
npm run verify:workers:dist
npm run build:web
```

`verify` = `typecheck` (весь `src/` с тестами) + `npm test` (`*.test.ts`,
`*.spec.ts`) + `verify:workers`, `verify:site-db`, `verify:site-api`,
`verify:player-stats*`, `verify:player-board*`, `verify:benchmark-corpus`;
по затронутой подсистеме их можно запускать отдельно. Baseline на
**2026-10-02**: gates проходят, **297 pass, 0 fail**, корпус — 6 сценариев
(включая 2.59). Изменилось число тестов — назови новое; любое новое падение —
регрессия.

CI (`.github/workflows/ci.yml`): те же шаги на Linux (Node 26, как образ) и
Windows (Node 24), `npm audit`, сборка Docker-образа. Меняя `FROM node:` в
`Dockerfile`, поднимай Node в Linux-job. `--test-force-exit` в `npm test` не
добавлять: на Windows с Node 24 он роняет тесты с fetch (libuv assert), а
зависающих тестов нет. Dependabot — раз в неделю.

Только с явного разрешения (внешние или локальные эффекты):

- `npm run dev`, `npm start`, `npm run dev:bot`, `npm run start:bot`;
- `npm run deploy:commands` — меняет slash-команды Discord;
- `npm run backfill -- <days>` — сеть и запись в БД;
- `npm run analyze -- <limit>` — платные вызовы API;
- `npm run battle -- <id>` — может скачать реплей и построить media;
- `verify:player-stats-live`, `verify:statshark-live`, `verify:wt-transport`,
  `benchmark:performance-soak` — внешние сервисы (soak очищает
  `WT_BATTLES_CHANNEL`, но использует сеть и БД).

Разрешённый живой запуск: дождись Discord ready и web listen; проверь
`/health`, `/api/stats` (статус каждого источника), `/api/items?limit=3`,
`/api/voice`, логи парсеров и ingest, отсутствие повторной записи неизменных
items. Строки `[ingest] бой …: убийств N, победитель …`: сплошные «убийств 0,
победитель ?» — разбор сломан патчем игры (раздел 7). С заданным
`WT_BATTLES_CHANNEL` очередь анонса уйдёт в настоящий канал — оцени её
заранее. Работающего бота в Docker проверяй по логам и API (скилл `verify`).
Windows: после watch-run проверь дочерние node и порт 3000 —
`process.kill(pid, 'SIGINT')` завершает без обработчиков, graceful shutdown
проверяется Ctrl+C или `docker compose stop`. `ExperimentalWarning: SQLite` —
норма на Node ≤ 24, Node 26 его не печатает.

## 11. Лицензии

AGPL-3.0-or-later (`LICENSE`, `package.json`). Часть `src/wrpl/*` — порт
AGPL-3.0 `wrpl-inspector`; GMSync (`gm-sync.ts`) — по BSD-3-Clause
`WrplReplayParser` и Dagor Engine; происхождение — в SPDX-заголовках. Тексты
BSD-3-Clause лежат в `LICENSES/` и копируются в Docker-образ (условие
лицензии). `/` и SPA показывают ссылку на исходный код (AGPL §13). Лицензии
runtime-пакетов и шрифта SPA — `frontend/public/THIRD_PARTY_NOTICES.txt`: новая
frontend-зависимость — дополни его.

## 12. Git и сдача

- Добавляй только конкретные файлы (не `git add -A`/`git add .`). В коммит не
  попадают `data/`, `.env`, `dist/`, `node_modules/`, `.idea/`, архивы,
  локальные бэкапы, `*.tsbuildinfo`.
- Перед коммитом: `git status --porcelain -uall`, `git diff --cached`; staged
  diff — без секретов, БД, cookies, дампов и сгенерированного.
- Сообщение коммита называет всё, что в нём есть: новый модуль или изменение
  поведения не прячут за «change test timeout».
- Сдача: gates зелёные, `git diff --check` чистый, diff — только по запросу;
  назови живые проверки, которые сознательно не запускались.
