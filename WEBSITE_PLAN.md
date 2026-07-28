# План сайта: игроки, кланы и интерактивная карта боя

> **Статус.** Этапы 0–4 реализованы как MVP: read-модель сайта
> (`SITE_SQL` в `src/db/index.ts`, проверка планов — `npm run verify:site-db`),
> API `/api/players|clans|battles|vehicles` + сцена боя
> (`src/web/routes/site.ts`, worker-задача `prepare-scene`), SPA на Vite+React
> (`frontend/`, раздаётся на `/app`) и Canvas-плеер «карта-видео»
> (`frontend/src/components/ScenePlayer.tsx`). Демо на фикстурах:
> `npx tsx src/analysis/site-preview.ts` → http://127.0.0.1:3210/app.
> Этап 5 (публикация: proxy, auth, AGPL) НЕ выполнен — наружу не выставлять.
> Визуальный редизайн применён по экспорту Claude Design («Редизайн игрового
> портала.zip»): токены в `frontend/src/theme.css`, цвета серий/команд
> затемнены до прохождения валидатора палитры; витрина дизайн-системы —
> `frontend/design/` и проект «wtbot» на claude.ai/design.
> Сверх плана реализовано: `/api/site-stats`, история суммы ПКР клана,
> дельты «за 30 дн.», подписи команд «X против Y», живые подсказки поиска,
> лента событий в плеере, `clan_roster` (покинувшие клан исключаются из
> сумм/дельт/истории), панель `/` в единой теме, `npm run site` (реальная БД
> без бота), smoke `verify:site-api`/`verify:site-db`. Производительность на
> HDD: прогрев горячих страниц при старте, mmap/кэш SQLite, покрывающий
> индекс рейтингов, сторожок event loop в боте.
> Ниже — исходный план; отклонения реализации помечать здесь.

## Цель

Три пользовательских результата поверх уже собираемых данных:

1. **Страница игрока** — подробная статистика: аккаунт из внешних источников
   (StatShark + официальный профиль), локальные бои из `.wrpl`, графики
   истории (ПКР, бои/победы/винрейт по снимкам), техника, алиасы, последние
   бои со ссылками на плеер.
2. **Страница клана** — ростер с ПКР и дельтами, история рейтинга участников,
   агрегаты по локальным боям (винрейт, активность, счёт), последние бои,
   ссылки на страницы игроков.
3. **«Карта-видео»** — интерактивный плеер боя: анимация траекторий по
   тактической карте с таймлайном, маркерами килов и выбором юнитов/команд.

## Что уже есть (инвентаризация)

Данные собираются и хранятся, новый парсинг не нужен:

- **Аккаунт игрока**: `player_external_snapshots` + `player_external_totals` +
  `player_external_vehicles` — change-point история двух источников
  (`statshark`, `official-profile`); `wt_player_snapshots` — история
  официального профиля до 400 дней; identity — `player_identities` +
  `player_identity_aliases`.
- **Локальные бои**: `battles`, `battle_players`, `battle_kills`, `battle_chat`;
  период-фильтр есть в `getPlayerReplayStats([from,to))`; по игроку есть
  покрывающий индекс `idx_bp_user_id (user_id, session_id)`.
- **Кланы**: словарь `clans` (tag → name), `clan_rating_snapshots` —
  change-point история ПКР участников (дельта = две последние строки).
  ВАЖНО: `clans.tag`, `battle_players.clan_tag` и
  `clan_rating_snapshots.clan_tag` хранят **сырой тег с украшениями** игровым
  шрифтом; стабильное «ядро» тега даёт `clanTagCore`/`stripClanDecorators`
  (`src/wrpl/render-battle.ts`).
- **Для плеера**: `battles.events_blob` (nullable gzip JSON `ReplayEvents`,
  `src/wrpl/replay-events.ts`): `units[].path: SpaceTime[]` с точками
  `{t, x, y, z}`, `kills[]` (позиции nullable), `zones[]`, `chat[]`,
  `endTime`. Юниты — это **vehicle-entity, а не игроки**: с респаунами и БПЛА
  их заметно больше 32, у части `userId` пустой.
- **Карты и словари**: `data/maps/` — ленивый download-кэш с wt-tools
  (файл может отсутствовать, пока heatmap боя ни разу не строили);
  `data/wt-vehicles.json` через `ensureVehicleDict` — id → имя/класс/страна;
  `data/unit-icons/` — силуэты (тоже ленивая догрузка).
- **Веб-слой**: Fastify 5 (`src/web/`), шаблон rate limit в
  `src/web/routes/player-stats.ts`, read-model игрока —
  `PlayerStatsCoordinator.lookup()` (`src/player-stats/comparison.ts`).
  ВАЖНО: `lookup()` не является чистым чтением — может писать identity
  (`savePlayerIdentity`) и ставить внешний refresh в очередь.
- **CPU-пул**: `src/workers/` — воркеры НЕ имеют доступа к SQLite; все данные
  маршалит main thread через wire-протокол (`src/workers/protocol.ts`),
  очередь 32 задачи, бюджет transferable-байт, timeout на задачу.

## Архитектура целевого решения

```text
SQLite (новых таблиц нет; допускаются новые индексы)
   │  типизированные функции в src/db/index.ts
   ▼
Fastify JSON API (src/web/routes/…)
   │        └─ тяжёлая подготовка сцены: main thread читает БД и маршалит
   │           буферы → CPU-worker (gunzip/прореживание/gzip) → кэш
   ▼  same-origin
SPA: frontend/ (Vite + React + TS) → сборка в статику → @fastify/static на /app
   └─ плеер карты: Canvas 2D поверх изображения карты (React — только обвязка)
```

Решения и причины:

- **React оправдан** из-за плеера и многостраничности; текущий дашборд `/`
  остаётся vanilla, SPA живёт на `/app/*` (конфликтов с `/`, `/health`,
  `/api/*` нет).
- **Frontend — отдельный `frontend/package.json`**: корневой lock и `npm ci`
  бэкенда не затрагиваются; `tsc -p tsconfig.json` собирает только `src/`.
- **Canvas 2D, не WebGL**: цель — 60 fps при ~100 путях юнитов
  (vehicle-entity); для Canvas 2D это комфортно, зависимость нулевая.
- **Схема БД**: новых таблиц нет; новые **индексы допускаются** (см. этап 1).

## Этапы

### Этап 0 — решения до кода (маленький)

1. **Лицензия (блокер публичного запуска, не разработки).** `src/wrpl/*`
   содержит порт AGPL-3.0 кода; публичный сайт задействует сетевую оговорку
   AGPL. До открытия наружу: согласовать публикацию исходников под AGPL либо
   переписывание затронутых модулей. Локальная разработка не блокируется.
2. **Адресация игрока**: канонический URL — `/app/players/<wt_user_id>`;
   для identity без числового id — `/app/players/id/<identity_id>`
   (разрешение через `getPlayerIdentityById`, НЕ через `lookup()` — тот
   принимает только ник/WT user id). Ники в URL не используются.
3. **Адресация клана**: URL и агрегация — по **ядру тега** (`clanTagCore`),
   не по сырому украшенному тегу: украшения нестабильны и непрактичны в URL.
4. **Маршрут SPA**: `/app/*` same-origin (без CORS и второго порта).

### Этап 1 — API игрока и клана (большой)

Новые роуты (плагины в `src/web/routes/`, зависимости через `WebDeps`;
весь SQL — новыми параметризованными функциями в `src/db/index.ts`):

- `GET /api/players/:key` — профиль, **строго read-only**: только кэшированные
  снимки и локальные данные, без `savePlayerIdentity` и без постановки
  внешних refresh в очередь. Обновление — отдельным `POST /api/players/:key/refresh`
  по образцу `/api/player-stats` (rate limit обязателен). Явно описать пустые
  состояния: игрок без снимков, `STATSHARK_PLAYER_STATS_ENABLED=false`
  (по умолчанию) → state `disabled`, и т.п.
- `GET /api/players?query=&limit=` — **поиск/список игроков** (без него на
  страницы игроков нечем попасть): префиксный поиск по `player_identities` +
  `player_identity_aliases` + `battle_players.nick_base`, сортировка по
  активности; новые DB-функции и, при необходимости, индексы. Существующий
  `findKnownPlayerMatches` ищет только точный ник — не переиспользуется.
- `GET /api/players/:key/history` — временные ряды:
  - ПКР: из `clan_rating_snapshots`, но **не по одному `nick_base`**
    (коллизия «Foo» и «Foo@psn») — по точным `nick` алиасов identity,
    при необходимости с ограничением по `clan_tag`;
  - аккаунт: агрегатные строки по истории `player_external_snapshots` +
    `player_external_totals`, каждая source-линия отдельно, не суммировать;
  - активность: бои/день из `battle_players` × `battles.start_time`
    (покрывающий `idx_bp_user_id` уже есть).
- `GET /api/clans` — список кланов (последние строки `clan_rating_snapshots`,
  группировка по ядру тега).
- `GET /api/clans/:coreTag` — ростер с ПКР/дельтами и историей; агрегаты боёв
  клана из `battle_players` × `battles` **по нормализованному ядру тега**.
  Производительность: `idx_bp_clan (clan_tag)` не покрывающий — добавить
  `CREATE INDEX idx_bp_clan_session ON battle_players (clan_tag, session_id)`;
  агрегаты считать за ограниченный период по умолчанию и кэшировать в памяти
  с TTL — SQLite синхронный, полный пересчёт истории на каждый GET блокирует
  event loop бота и ingest.
  **Линковка ростера с игроками — отдельная работа**: в снимках рейтинга нет
  `wt_user_id`, автоматический merge identity по нику запрещён правилами
  репозитория. Резолв — read-only JOIN через `player_identity_aliases` по
  `nick_base` (индекс есть) с правилом: несколько identity на один ник → **не
  линковать**; неразрешённые ники отдаются без ссылки.
- `GET /api/battles?clan=&player=&from=&to=&limit=` — лента боёв для страниц
  клана **и игрока** (вход в плеер со страницы игрока; фильтр по
  `battle_players.user_id`).
- `GET /api/battles/:sessionId` — скорборд: JSON-вариант данных
  `getBattleSummaryForRender`.
- `GET /api/vehicles` — словарь техники id → `{name, cls, country}` из
  `ensureVehicleDict` с долгим `Cache-Control`: без него сайт показывает
  сырые id вида `us_m1a1_hc_abrams`. Решить доставку иконок классов/силуэтов
  (`data/unit-icons/` догружается лениво с GitHub) — статикой или эндпоинтом.

Общие правила: schema validation входа, rate limit по образцу
`player-stats.ts`, пагинация с верхней границей — на **всех** роутах этапа.

Готовность: `npm run build`; оффлайн smoke через Fastify `inject()` +
SQLite `:memory:` (по образцу `src/analysis/player-stats-api-smoke.ts`) на все
новые роуты, включая 400/404/429 и read-only-гарантию `GET /api/players/:key`
(после GET в БД не появилось новых identity/снимков).

### Этап 2 — каркас SPA (средний)

- `frontend/`: Vite + React + TypeScript + react-router; графики — uPlot.
- Сборка: `frontend/dist` → `@fastify/static` (новая зависимость бэкенда) на
  `/app`; SPA-fallback на `index.html` только под `/app/*`.
- Dev-режим: `vite dev` с proxy `/api` → `http://localhost:3000`.
- Скрипты в корне: `build:web`, `dev:web`; основной `npm run build` фронтенд
  не трогает.
- Страницы: поиск/список игроков, игрок (`/app/players/…` — включая блок
  «последние бои» со ссылками на бой), клан (`/app/clans/:coreTag`), бой
  (`/app/battles/:sessionId` — скорборд), список кланов.
- Имена техники и иконки — через `GET /api/vehicles` (кэш на клиенте).
- Безопасность разметки: только JSX-текст, `dangerouslySetInnerHTML` запрещён.

Готовность: страницы рендерятся из API этапа 1 с графиками истории;
`npm run build:web` собирается чисто.

### Этап 3 — сцена боя для плеера (большой)

**Контракт задачи** (по образцу `MediaRenderInput` в
`src/workers/protocol.ts` и `doBuildBattleHeatmap2x` в
`src/wrpl/battle-media.ts`) — воркер не видит БД, всё маршалит main thread:

1. Main thread: `reconstructBattle(sessionId)` → `events_blob` (gzip Buffer),
   миссия (`fetchMissionInfo`), словарь техники, **выбор карты фиксируется
   здесь же** (какой файл `data/maps/` или fallback использован — записывается
   в сцену). При `events_blob IS NULL` — HTTP 404, плеер деградирует до
   «данные боя недоступны». CDN-фолбэка нет (образец — строгий DB-путь
   `buildBattleHeatmap2x`, не общий media-путь).
2. Worker-задача `prepare-scene`: вход — transferable `ArrayBuffer` блоба +
   метаданные калибровки; внутри gunzip, прореживание (шаг ~1 с +
   Дуглас–Пекер), сборка JSON и **gzip результата в воркере**; выход —
   transferable `ArrayBuffer` (дешевле structured clone и сразу пригоден для
   кэша и `Content-Encoding: gzip`). Явный `timeoutMs` (как у media — 120 с);
   помнить про очередь пула (32 задачи) и бюджет transferable-байт.
3. Формат сцены:

   ```text
   {
     map: { file, worldToImage, mode },   // зафиксированный выбор и режим
     endTimeMs,
     units: [{ unitId, userId|null, model, source, path: [[t,x,z], …] }],
     kills: [{ t, killerId, victimId, weapon, x|null, z|null }],
     zones: [{ name, x, z }],
     players: [{ userId, nick, team }]    // join юнитов — на клиенте по userId
   }
   ```

   `nick`/`team` у юнита нет — юниты это vehicle-entity, часть без `userId`
   (ИИ/дроны) — плеер их показывает отдельным нейтральным стилем.
4. **Калибровка world→image — отдельная работа, не переиспользование**:
   в `prepareHeatmapScene` px/pz — несериализуемые замыкания, а привязка
   изображения к канвасу живёт в `buildHeatmapSvg` и зависит от режима
   (ground/air, mission.area, viewport). Нужно экспортировать аффинные
   параметры (cx, cz, half, view) из `render-heatmap.ts` либо строить
   калибровку в `prepare-scene`; для смешанных боёв определить, какой режим
   задаёт `worldToImage` сцены (или включить оба viewport в сцену).
5. **Кэш сцен — НЕ через `meta.artifacts`** (закрытое множество
   `BattleMediaKind`, PNG-валидация файлов, bump `BATTLE_MEDIA_VERSION`
   инвалидирует все bundle). Отдельный файл
   `data/battles/<sessionHex>-scene-<versionHash>.json.gz` по образцу
   `highResCacheFile`: version-hash в имени, `writeFileAtomic`,
   `enforceCacheCap` (eviction подхватит по префиксу session автоматически),
   без зависимости от `meta.json`.
6. Роуты: `GET /api/battles/:sessionId/scene` (кэш → иначе сборка через пул с
   дедупликацией одинаковых session и **конкурентным бюджетом на роуте** —
   разные session из одного скрипта иначе выбьют очередь пула, страдают и
   Discord-кнопки; приоритет фоновых сборок — `normal`, не `interactive`) и
   `GET /api/battles/:sessionId/map.png` — отдаёт ровно тот файл, что записан
   в сцене, не переигрывая выбор. Политика холодного кэша карт: догрузка через
   `ensureTacticalMap` (timeout/лимит размера уже есть) либо 404 с деградацией
   плеера — решить при реализации, вариант зафиксировать в AGENTS.md.
7. **Rate limit, schema validation session_id и лимиты размера — здесь, в
   этапе 3**, не в этапе 5 (требование AGENTS.md для всех внешних границ).

Готовность: smoke — сцена известного боя из фикстур собирается в бюджет
(≤ ~1–2 МБ до gzip), повторный запрос идёт из кэша, бой без `events_blob`
отдаёт 404; `npm run verify:workers` проходит.

### Этап 4 — плеер «карта-видео» (большой)

- Canvas 2D поверх `<img>` карты; `requestAnimationFrame`; позиция юнита —
  линейная интерполяция соседних точек `path` по текущему времени.
- Управление: play/pause, скорость (1×/4×/16×), таймлайн-скраббер по
  `endTimeMs`, прыжки к килам; фильтр команд/игроков; хвост траектории за
  последние N секунд; маркеры килов с подписью (убийца → жертва, оружие);
  зоны захвата. Килы без координат — только в ленте событий, не на карте.
- Цвета команд — валидированной палитрой (как в дашборде); идентичность юнита
  не только цветом: иконка класса + подпись ника (через `/api/vehicles`).
- Деградация: пустой `units` (реальный случай после патчей игры, MPI-id —
  см. AGENTS.md) → карта + килы по времени + сообщение «траектории
  недоступны»; юниты без `userId` — нейтральный стиль «ИИ/дрон».
- Производительность: 60 fps при ~100 путях на десктопе; на мобильном —
  DPR-скейлинг канваса, отрисовка только видимых хвостов.

Готовность: ручная проверка на 3–5 реальных боях разных режимов (наземный,
авиа, смешанный) + бой без траекторий; профилирование без длинных кадров.

### Этап 5 — публикация (средний, только когда решён этап 0.1)

- Reverse proxy (nginx/caddy) перед Fastify; наружу — только proxy.
- Доступ: приватно — basic auth на proxy; публично — отдельный план
  (Discord OAuth).
- **Внешний refresh для анонимного трафика запретить/ограничить**: просмотр
  страницы игрока не должен гонять Edge-транспорт warthunder.com/StatShark;
  `POST …/refresh` — только с жёстким лимитом или за auth.
- Приватность данных: `data/wtbot.db` содержит Discord ID и чат боёв — API не
  отдаёт Discord-поля вообще; чат — только по явному запросу и осознанному
  решению.
- Бэкап БД по расписанию перед публичным запуском.

## Риски и открытые вопросы

| Риск | Митигция |
|---|---|
| AGPL-порт в `src/wrpl/*` при публичном запуске | Этап 0.1: решить до открытия наружу; разработка не блокируется |
| Воркеры не видят БД; большие блобы | Контракт «main thread маршалит буферы» (этап 3.1–3.2); transferable, лимиты пула, явный timeout |
| Клан-теги с украшениями фрагментируют агрегаты | Ядро тега (`clanTagCore`) как ключ адресации и агрегации; новый покрывающий индекс |
| Синхронный SQLite в main thread | Агрегаты кланов — ограниченный период + TTL-кэш; покрывающие индексы |
| Траектории пропадают после патчей (MPI-id) | Плеер работает без `units`; сверка сигнатур — существующий процесс |
| Ник ≠ стабильный ключ; в ПКР-снимках нет user_id | URL по `wt_user_id`/identity id; линковка ростера только через алиасы, коллизии не линкуются |
| `lookup()` пишет в БД и ставит внешние запросы | GET-роуты строго read-only; refresh — отдельный POST с лимитами |
| `data/maps/` — ленивый кэш, файла может не быть | Политика холодного кэша в этапе 3.6; деградация плеера |
| `events_blob` NULL у части боёв | 404 + деградация, задокументировано в API |
| Web слушает `0.0.0.0` без auth | Rate limit с этапа 1/3; наружу — только после этапа 5 |
| Frontend-стек добавляет сборку | Изолирован в `frontend/`; бэкенд-пайплайн не меняется |

## Вне рамок этого плана

- Экспорт «видео» в mp4 (интерактивный плеер закрывает потребность).
- Миграция на Postgres, Discord OAuth, мультиязычность.
- Нормализация StatShark-историй (`vehicleHistory`/`leaderboardHistory` из
  `raw_json`) — отдельная задача после MVP; графики этапа 1 строятся по
  собственным снимкам.
- Переписывание текущего дашборда `/` на React.

## Соответствие правилам репозитория (AGENTS.md)

- SQL — только в `src/db/index.ts`, параметризованный, пачки — в транзакциях.
- Тяжёлый разбор/gunzip/большой JSON/gzip — только в `src/workers/entry.ts`;
  в воркер — только structured-clone-совместимые данные и transferable
  `ArrayBuffer`, никаких handles БД/Fastify/Discord.
- Новые env-переменные — одновременно `src/config.ts`, `.env.example`, AGENTS.md.
- Все внешние границы — schema validation + rate limit + лимиты размера,
  начиная с этапа, в котором эндпоинт появляется.
- Минимальная проверка шага — `npm run build` + оффлайн smoke через
  `inject()`/`:memory:`; живой запуск — только по явному разрешению.
