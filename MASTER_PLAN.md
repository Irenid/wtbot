# Единый план wtbot

Дата анализа: 2026-07-29  
Источники: `AUDIT.md`, `IMPROVEMENT_PLAN.md`, `PERFORMANCE_PLAN.md`, текущий код,
скрипты проверки и состояние рабочей копии.

`AGENTS.md` задаёт актуальные архитектурные и эксплуатационные контракты.
Этот документ является roadmap и реестром статусов; при расхождении приоритет
имеют текущий код, схема SQLite и затем `AGENTS.md`.

## 1. Как читать этот документ

- **Готово**: механизм присутствует и подтверждён кодом или проверкой.
- **Частично**: часть работы есть, но остался измеримый дефект, отсутствие
  проверки или незавершённая миграция.
- **Открыто**: задача не реализована.
- **Отложено**: задача допустима только после измерений или закрытия
  блокирующих пунктов.
- **Проверить после коммита**: текущая рабочая копия содержит незакоммиченные
  изменения, поэтому статус нельзя считать свойством `master`.

Этот план не предлагает откатывать или перезаписывать текущие изменения.
Коммиты и публикация в remote в рамках этого задания не выполнялись.

## 2. Текущее состояние

### 2.1. Проверки на момент анализа

| Проверка | Результат | Вывод |
| --- | --- | --- |
| `npm run build` | Готово | TypeScript собирается |
| `npm test` | 78 pass, 0 fail | Включает backup, replay, lock, Unicode, migration, security, binary-bounds и season regression tests |
| `npx tsx --test src/wrpl/render-heatmap.spec.ts` | 3 pass | Файл всё ещё не входит в обычный тестовый запуск |
| `npm run build:web` | Готово | SPA собирается |
| `npm run verify:site-db` | Готово | Большие scan разрешены только по точному явному allowlist |
| `npm run verify:workers` | Готово | Source smoke зелёный |
| `npm run verify:workers:dist` | Готово | Dist smoke зелёный |
| `npm audit --omit=dev --audit-level=high` | 0 high advisory | Результат первого прогона 2026-07-29 |

Повторный локальный прогон 2026-07-29 заново подтвердил `build`, 78/78 tests,
frontend build, отдельный heatmap spec, `verify:site-api`, `verify:site-db`,
player-stats API/DB/provider smoke, player-board/voice smoke и source/dist
worker smoke на текущей рабочей копии с незакоммиченными изменениями сезона и
аудита. `npm audit` во втором, документационном проходе не повторялся; перед
коммитом или релизом его результат нужно подтвердить снова.

### 2.2. Что уже сделано

1. Тяжёлый WRPL-разбор, gzip/zstd, Resvg и геометрия вынесены в
   `worker_threads`.
2. CPU-пул имеет приоритеты, ограничение очереди и transferable bytes,
   резерв интерактивных задач, защиту ingest от полного захвата слотов,
   timeout и замену worker.
3. Рендер строит только нужный media kind, общие данные heatmap готовятся один
   раз, параллельные сборки одной сессии дедуплицируются.
4. Файловый battle-cache публикует `meta.json` последним, использует LRU и
   умеет восстанавливать материалы из SQLite.
5. Оптимизированы шрифты Resvg, добавлены corpus-бенчмарки, фазы worker,
   проверки размера, RSS и event-loop lag.
6. `/api/voice` переведён с основного N+1-пути на batch DB API.
7. `/api/stats` и voice refresh используют кэширование, single-flight,
   rate-limit и diff обновления присутствия.
8. Загрузка replay parts использует ограниченный pipeline, byte budget,
   отмену соседних запросов и раздельные timing-фазы.
9. SQLite работает в WAL, добавлен `PRAGMA busy_timeout = 5000`, есть базовые
   индексы и `verify:site-db`.
10. Три старых падения рендера, описанные в `AUDIT.md`, сейчас не
    воспроизводятся: текущий `npm test` даёт 78/78.
11. Текущая рабочая копия дополнительно содержит незакоммиченную функциональность
    сезона, обновления SPA, API, рейтингов и связанных smoke-тестов. Это нужно
    сохранить отдельно и не смешивать автоматически с исправлениями аудита.
12. Первый P0-блок реализован в рабочей копии: loopback web по умолчанию,
    bearer auth и CSRF для non-loopback, safe Fastify 5xx, worker cap 8 и
    индекс `idx_battles_session_hex`.
13. Второй блок частично реализован: bounds-check для BitReader, varint,
    packet fields, LZ4 и ECS, лимиты zlib/zstd/gzip, классификация
    `EXEC_TIMEOUT`, guarded DB startup, `db:backup` с `VACUUM INTO` и
    `quick_check`, backoff parser-источников до 30 минут, cap 50 страниц
    планового `wt-replays` и общий WT limiter для `wt-clans`.
14. Дополнительно закрыты batch N+1 для кланов команд в battle feed,
    browser-page waiters/deadlines/cleanup, VROMFS и FAT BLK bounds, NUL в
    `site.ts`, repository attributes/ignore и все npm advisories.
15. Backup проверяет свободное место, использует process lock и удаляет
    неполную копию; `wt-replays` имеет offline source-level fixtures; cookie
    jar безопасно reclaim-ит stale lock мёртвого процесса; дорогие battle
    filters расходуют rate-limit с весом 4.
16. Поиск игроков использует Unicode casefold keys и отдельные индексы для
    identity, aliases и replay nick; legacy schema мигрируется и проверена на
    кириллице, ASCII и суффиксе `Z`.
17. Legacy `ALTER`/backfill миграции переведены на `PRAGMA user_version`,
    выполняются по одному в `BEGIN IMMEDIATE`, откатываются при ошибке и
    отвергают более новую неизвестную schema. Большой bootstrap DDL в
    `initDb()` всё ещё выполняется вне registry, поэтому полная
    версионированность схемы пока не достигнута.
18. Добавлен сезонный контур: UTC-расписание и boundary test, таблицы сезона и
    этапов, сезонная граница рейтингов, контекст в site API/SPA и строка
    сезона с максимальным БР в `/battle`.

### 2.3. Что в документах устарело

1. `AUDIT.md` и `IMPROVEMENT_PLAN.md` описывают красные тесты, но текущий
   запуск зелёный.
2. `PERFORMANCE_PLAN.md` корректно отмечает закрытые P0.2, P1.2, P1.3 и P1.4,
   но его пункт про незакрытый лимит worker-пула уже устарел в текущей рабочей
   копии.
3. `busy_timeout` уже добавлен и не должен повторно планироваться как новая
   задача.
4. `data.rar`, упомянутый в старых разделах, в текущем корне не обнаружен.
   `.gitignore` уже усилен для архивов, локальных env-файлов и tsbuildinfo.
5. Старый `verify:site-db` разрешал любой `SCAN ... USING INDEX`. Текущая
   версия допускает scan большой таблицы только по точному именованному
   allowlist, поэтому новый случай не пройдёт незаметно.

## 3. Приоритеты

### P0. Безопасность и отказоустойчивость

Эти задачи нужно выполнить до публичного или длительного запуска.

#### P0.1. Закрыть web-периметр

**Статус: Готово в текущей рабочей копии.**

Добавлены `WEB_HOST=127.0.0.1` по умолчанию, обязательный `WEB_TOKEN` для
non-loopback, bearer hook на `/`, `/app` и `/api`, timing-safe сравнение и
CSRF-проверка POST по `Origin`/`Sec-Fetch-Site`.

Выполнено:

- добавить `WEB_HOST`, по умолчанию `127.0.0.1`;
- разрешать `0.0.0.0` только явным opt-in;
- добавить `WEB_TOKEN` для non-loopback режима;
- сравнивать токен через `crypto.timingSafeEqual`;
- закрыть `/api/*` единым `onRequest` или route preHandler;
- добавить CSRF-проверку для POST через `Origin` и `Sec-Fetch-Site`;
- не отдавать `/api/voice` и административные страницы без разрешения;
- не логировать токены, cookie и содержимое `.env`.

Файлы: `src/config.ts`, `src/index.ts`, `src/web/index.ts`,
`src/web/routes/api.ts`, `src/web/routes/player-stats.ts`, smoke API.

Приёмка:

- loopback работает без внешней auth-конфигурации;
- non-loopback без `WEB_TOKEN` не стартует или не принимает API;
- неверный токен даёт 401/403;
- cross-origin POST отклоняется;
- existing rate-limit и single-flight сохраняются.

#### P0.2. Добавить единый error handler и наблюдаемость

**Статус: Частично, runtime-механизм готов, process-level проверка отсутствует.**

Fastify теперь скрывает детали 5xx от клиента, пишет stack в серверный лог и
нормализует 404. Discord shard/rejection handlers и глобальный controlled
shutdown для `unhandledRejection`/`uncaughtException` добавлены. Unit/inject
проверка подтверждает безопасное тело 500, но отдельный дочерний процесс пока
не проверяет startup failure, код выхода и порядок shutdown.

Выполнено:

- добавить `setErrorHandler` в `buildServer`;
- для 4xx возвращать нормализованный код и безопасное сообщение;
- для 5xx возвращать обобщённое сообщение, настоящий stack писать в лог;
- добавить единый формат `{ ok: false, code, error }`;
- разделить API 404 и SPA 404;
- зарегистрировать SIGINT/SIGTERM в самом начале `src/index.ts`, до
  инициализации SQLite, Discord и parser.

Осталось:

- добавить process-level startup/fatal smoke: отсутствующая DB не создаётся,
  процесс выполняет controlled shutdown, не оставляет дочерние процессы и
  завершается с кодом 1;
- зафиксировать порядок остановки producers/browser/Discord/pool/DB тестом или
  наблюдаемым lifecycle trace.

Файлы: `src/web/index.ts`, `src/web/routes/spa.ts`, `src/bot/index.ts`,
`src/index.ts`, `src/parsers/index.ts`.

Приёмка:

- 5xx не содержит абсолютных путей, имён файлов, cookie или stack trace;
- каждая ошибка видна в серверном логе;
- graceful shutdown закрывает producers, browser, workers и DB в текущем
  порядке;
- smoke-тест проверяет API 400, 404 и 500.

#### P0.3. Согласовать лимит worker-пула

**Статус: Готово в текущей рабочей копии.**

`MAX_CONFIGURABLE_WORKERS` вынесен в `runtime-options.ts`; auto и явное
значение ограничиваются восемью до создания пула. Smoke проверяет 12 CPU и
явное значение 9; source и dist проверки зелёные.

Выполнено:

- вынести `MAX_CONFIGURABLE_WORKERS` в общий модуль;
- ограничить авто- и явный режим через `Math.min(..., 8)`;
- проверить совместимость `backgroundReserveSlots` после clamp;
- добавить тест расчёта пула для 9, 12 и auto CPU;
- обновить `worker-smoke.ts` и dist smoke.

Опциональное дальнейшее улучшение: ленивый `getWorkerPool()`.

Файлы: `src/runtime-options.ts`, `src/workers/pool.ts`,
`src/analysis/worker-smoke.ts`.

#### P0.4. Убрать полный скан `battles` по hex-ключу

**Статус: Частично, основной дефект закрыт.**

Добавлен `idx_battles_session_hex`. `verify:site-db` показывает
`MULTI-INDEX OR`: primary key для `session_id` и новый индекс для
`session_hex`, без `SCAN battles`.

Выполнено:

- добавить индекс `idx_battles_session_hex`;
- добавить `EXPLAIN QUERY PLAN` для OR lookup;
- проверить web API через `verify:site-api`.

Осталось:

- измерить холодный и тёплый lookup на fixture, где `events_blob` большой;
- отдельно проверить Discord `/battle` и media buttons без живой отправки.

Файлы: `src/db/index.ts`, `src/wrpl/battle-media.ts`,
`src/bot/commands/battle.ts`, `src/analysis/site-db-explain.ts`.

#### P0.5. Защитить бинарный разбор недоверенных данных

**Статус: Частично, основные границы закрыты.**

Аудит воспроизвёл бесконечные циклы и silent truncation в `BitReader`,
`deserializeIdFields32` и LZ4. Основные bounds-check и лимиты декомпрессии
добавлены, а timeout выполнения теперь имеет код `EXEC_TIMEOUT` и считается
scheduling error.

Сделано:

- `BitReader.readBits()` проверяет длины через безопасную арифметику, без
  32-битного `>>`;
- `readCompressed()` ограничивает shift и отвергает NaN/Infinity;
- `ignoreBits()` и `ignoreBytes()` валидируют смещения;
- `deserializeIdFields32()` ограничивает маску uint32 и `fieldNum < 32`;
- LZ4 проверяет каждый byte/offset/length до чтения;
- ECS/list-поля проверяют count относительно оставшегося буфера;
- все zlib/zstd-вызовы получают разумный `maxOutputLength`;
- VROMFS проверяет размер образа, тип упаковки, таблицы и точный размер zstd;
- FAT BLK ограничивает ULEB128, число описаний, ссылки на параметры и циклы;
- повреждённый input в проверенных слоях даёт доменную ошибку, а не зависание;
- execution timeout получает отдельный `EXEC_TIMEOUT` и классифицируется как
  scheduling error, чтобы не расходовать retry ingest/announce.

Файлы: `src/wrpl/bit-reader.ts`, `src/wrpl/packet-stream.ts`,
`src/wrpl/lz4.ts`, `src/wrpl/ecs.ts`, `src/wrpl/replay-events.ts`,
`src/wrpl/blk.ts`, `src/workers/pool.ts`, `src/wrpl/ingest.ts`.

Осталось:

- завершить аудит всех прямых bit-offset assignments и decompression call sites;
- добавить проверки ECS lower-bound для форматов с переменным размером элемента;
- добавить regression-тесты на превышение публичных decompression limits.

#### P0.6. Сделать восстановление данных и безопасный старт

**Статус: Готово в текущей рабочей копии.**

SQLite-файл около 2.4 ГиБ с `events_blob` является единственной копией старых
боёв. Ошибка в `DB_PATH` может создать новую пустую БД. Запуск теперь требует
явного разрешения для создания отсутствующего файла, а backup-команда делает
проверенную копию.

Сделано:

- добавить `npm run db:backup`;
- использовать отдельное read-only соединение и `VACUUM INTO`;
- проверять `quick_check` на созданной копии, не блокируя старт;
- ротировать ограниченное число backup-файлов;
- проверять свободное место с запасом перед `VACUUM INTO`;
- запрещать параллельный backup через owner lock;
- удалять неполную копию при ошибке;
- проверять backup, rotation, free-space и lock автоматизированным тестом;
- требовать явный `WTBOT_ALLOW_NEW_DB=1` для создания новой БД;
- валидировать `PORT` через `envNumber(..., 1, 65535)`;
- не печатать чувствительные значения в диагностике.

Процедура восстановления:

1. остановить bot/site и убедиться, что процесс больше не держит SQLite;
2. проверить выбранный backup через read-only `PRAGMA quick_check`;
3. переименовать текущий DB-файл в timestamped `.pre-restore`, не удаляя его;
4. скопировать backup во временный файл рядом с `DB_PATH`, повторить
   `quick_check` и только затем атомарно переименовать его в `DB_PATH`;
5. запустить сервис без `WTBOT_ALLOW_NEW_DB`, проверить `/health`, основные
   API и логи миграций; старый файл удалять только после отдельной проверки.

Файлы: `src/db/index.ts`, `src/config.ts`, новый CLI в `src/analysis/`,
`package.json`, `.env.example`.

## 4. P1. Корректность, производительность и эксплуатация

### P1.1. Ограничить плановый обход `wt-replays`

**Статус: Почти готово, source-level tests добавлены.**

До текущей рабочей копии плановый вызов не передавал `maxPages` или `sinceTs`.
Теперь он ограничен 50 страницами, но без временного окна всё ещё может
удерживать заметный массив `fresh` и занимать общую очередь запросов до cap.

Сделано:

- вернуть отдельную константу планового cap, например 50 страниц;
- передавать `maxPages` в `wtReplays.run()`;
- вернуть `hitCap` в summary и логировать warning;
- сохранить более высокий cap только для явного backfill;
- покрыть последнюю страницу, page cap, known page и date cutoff offline
  fixtures без сети и production DB.

Осталось:

- для обычного poll использовать окно по времени, если API даёт стабильную
  дату;

Файлы: `src/parsers/sources/wt-replays.ts`, `src/parsers/backfill.ts`,
`src/parsers/index.ts`.

### P1.2. Добавить exponential backoff источникам

**Статус: Готово в текущей рабочей копии.**

Ошибки parser source теперь учитываются отдельно по каждому источнику и
увеличивают задержку следующей попытки до 30 минут. Добавлены проверки
lifecycle, отсутствия наложения, остановки timers, duplicate source и
некорректного interval.

Сделано:

- хранить подряд идущие ошибки отдельно для каждого source;
- увеличивать delay после 401/403/пустой сессии/повторяющихся network errors;
- ограничить backoff примерно 30 минутами;
- сбрасывать состояние после успеха;
- не считать queue overflow, startup failure и scheduling timeout обычной
  попыткой ingest;
- логировать число подряд идущих ошибок и следующую задержку, а исходную
  причину сохранять в `parse_results`.

Файлы: `src/parsers/index.ts`, `src/parsers/types.ts`, smoke scheduler.

### P1.3. Схлопнуть N+1 и исправить контроль планов сайта

**Статус: Частично, основной N+1 закрыт.**

`/api/voice` и `battleListPayload()` batch-оптимизированы. Командные кланы до
100 боёв загружаются одним запросом через `json_each`, а `verify:site-db`
разрешает полные сканы больших таблиц только по точному явному allowlist.

Сделано:

- заменить цикл на один `IN (...) GROUP BY session_id, team, clan_tag`;
- разложить результат по session в памяти;
- сохранить параметризацию и ограничение размера списка;
- в `site-db-explain.ts` ввести `BIG_TABLES` и запрещать полный scan без
  явного объяснения;
- добавить weighted rate-limit с весом 4 для фильтров `player`/`clan`;

Осталось:

- прогонять планы против реальной БД в read-only режиме, когда она доступна;
- добавить benchmark cold/warm для 0, 10, 50 и 100 боёв.

Файлы: `src/web/routes/site.ts`, `src/db/index.ts`,
`src/analysis/site-db-explain.ts`, `src/analysis/site-api-smoke.ts`.

### P1.4. Исправить поиск игроков

**Статус: Частично, Unicode search path закрыт.**

Диапазонный поиск через SQLite `NOCASE` работает только для ASCII. Найденный
дефект затрагивал строчную кириллицу и ники, заканчивающиеся на `Z`.

Сделано:

- использовать Unicode NFKC + locale-neutral lowercase поле;
- добавить индексы для replay nick, identity nick и aliases;
- вычислять верхнюю границу уже для normalized search key;
- добавить regression tests для кириллицы, ASCII и `Z`, включая legacy schema;
- проверить, что поиск не меняет ограничения длины и rate-limit.

Осталось:

- прогнать benchmark на реальной БД и проверить стоимость legacy backfill на
  многогигабайтном файле.

Файлы: `src/db/index.ts`, `src/web/routes/site.ts`,
`src/analysis/site-api-smoke.ts`, схема и миграция индексов.

### P1.5. Убрать задержку пользователя на `buildClanSnapshot`

**Статус: Открыто.**

Снапшот кланов строится синхронно на первом запросе после TTL и блокирует
основной поток примерно на сотни миллисекунд. Полный `siteReplayPlayerCount`
также пересчитывается по запросу.

Сделать:

- строить snapshot периодическим unref-таймером;
- выдавать последний готовый snapshot из HTTP-запроса;
- считать `siteReplayPlayerCount` тем же фоновым циклом или инкрементальным
  агрегатом;
- заменить полные исторические проходы таблицы клановых рейтингов таблицей
  latest-state либо ограничением по свежести;
- добавить метрики времени построения, возраста snapshot и ошибок обновления.

Файлы: `src/web/routes/site.ts`, `src/db/index.ts`, `src/index.ts`,
smoke/benchmark сайта.

### P1.6. Исправить ростер клана и полноту рейтинга

**Статус: Частично.**

`clan_roster` уже существует, но пустой ростер трактуется как отсутствие
ограничения, поэтому рейтинг может включать ушедших игроков. Оконные запросы
для части истории уже добавлены, но fallback остаётся неправильным.

Сделать:

- отличать `rosterKnown: false` от полного состава;
- использовать только свежий snapshot fallback с фиксированным TTL;
- не считать пустой входящий roster подтверждением состава;
- логировать переход в fallback;
- добавить fixture с ушедшим игроком и частично загруженным составом;
- проверить дельту, total и average для кланов без полного roster.

Файлы: `src/db/index.ts`, `src/web/routes/site.ts`,
`src/wrpl/clan-info.ts`, `src/analysis/site-api-smoke.ts`.

### P1.7. Версионировать миграции SQLite

**Статус: Частично, legacy-преобразования версионированы.**

Широкий цикл `ALTER TABLE` удалён. `PRAGMA user_version` теперь является
реестром применённых `DB_MIGRATIONS`, но `initDb()` до их запуска по-прежнему
выполняет большой набор `CREATE TABLE/INDEX IF NOT EXISTS`. В частности,
сезонные таблицы появились через bootstrap DDL без новой schema version, так
что утверждать, что вся схема версионирована, пока нельзя.

Сделано:

- ввести массив `{ version, apply }`;
- выполнять шаги в `BEGIN IMMEDIATE`;
- обновлять `user_version` только после успешного шага;
- проверять наличие legacy-колонки до `ALTER TABLE`, не подавляя DDL errors;
- отказываться от старта при неизвестной более новой версии;
- проверить чистую БД, старую схему, повторный запуск и конкурентного
  писателя;
- проверить rollback незавершённой версии и закрытие connection при startup
  failure.

Осталось:

- определить отдельный clean-bootstrap path и не использовать
  `CREATE ... IF NOT EXISTS` как скрытую миграцию существующей БД;
- каждое новое/изменённое table/index/constraint оформлять новой version,
  одновременно поддерживая схему чистой БД;
- добавить versioned migration для уже добавленных сезонных таблиц либо
  документированную baseline-версию, которая однозначно доказывает их наличие;
- regression test: две БД с одинаковым `user_version` не должны незаметно
  получать разные структурные изменения только из bootstrap DDL.

Файлы: `src/db/index.ts`, `src/db/migrations.test.ts`,
`src/db/startup.test.ts`, `src/db/site-search.test.ts`,
`src/clan-season.ts`.

### P1.8. Исправить player-stats до включения витрин

**Статус: Частично, ambiguity и базовая нормализация уже закрыты.**

При исходном аудите локальная база показывала почти пустой внешний конвейер,
поэтому сначала нужно исправить корректность, а затем решить, включать ли
провайдеры в продукте.

Важно: official-profile уже включён по умолчанию и в `src/config.ts`, и в
`.env.example`; это не будущий opt-in. До закрытия перечисленных дефектов нужно
либо временно сделать безопасный default `false`, либо явно принять риск
текущего `true` и приоритетно завершить исправления.

Сделано:

- возвращать `ambiguous`, если подходящих identity несколько;
- отдавать API 409 с кандидатами для неоднозначного ника;
- различать air/ground/naval sections и не складывать branch respawns в
  `battles`;
- разбирать русское `м` как месяц, а `мин` как минуты согласно текущему
  контракту и fixtures;
- покрыть official-profile и StatShark normalizers offline tests.

Осталось:

- при появлении `wt_user_id` усыновлять единственную существующую nick-only
  identity, а при нескольких кандидатах возвращать `ambiguous`;
- не затирать уже распознанную branch-строку нераспознанной категорией;
- исправить plural `ships` и проверить naval fixture;
- ограничить нереалистично большую длительность;
- не складывать частично неизвестные режимы в агрегат как полный результат;
- официальный provider не должен повышать confidence переданного id, которого
  нет на странице профиля;
- согласовать политику `canonicalNick` после переименования;
- для каждого оставшегося дефекта добавить regression fixture.

Файлы: `src/player-stats/comparison.ts`,
`src/player-stats/normalizer.ts`, `src/player-stats/statshark-normalizer.ts`,
`src/player-stats/providers/official-profile.ts`,
`src/player-stats/service.ts`.

После исправлений принять решение:

1. сохранить default `true`, подтвердить живой Edge/Cloudflare transport и
   качество данных;
2. или сделать default `false`, заморозить внешние витрины и оставить только
   безопасный replay-срез.

SPA уже содержит условные account-блоки на `PlayerPage`: totals, режимы,
историю sources и технику, если snapshots существуют. До решения не расширять
их дальше, явно сохранять provenance/partial-data состояния и не смешивать
account coverage с replay coverage.

### P1.9. Восстановить cookie/browser recovery

**Статус: Почти готово.**

Cookie jar и browser pool теперь имеют автоматический recovery. Stale lock
удаляется только после проверки возраста и живости PID под отдельным
recover-guard; lock живого процесса не затрагивается.

Сделано:

- хранить reject в очереди waiters;
- отклонять waiters в `closeWtBrowser()`;
- добавить deadline в `acquirePage()`;
- закрывать Browser и child на провальных ветках startup/reconnect;
- не парковать busy-страницу;
- читать `pid`, `createdAt` и `ownerToken`;
- считать lock stale только после проверки владельца;
- проверять живость процесса и повторять acquire безопасно;
- покрыть owned, stale-dead и stale-live lock regression tests.

Осталось:

- проверить отдельный statshark page lifecycle;
- добавить recovery smoke без реального Cloudflare.

Файлы: `src/parsers/sources/wt-cookies.ts`,
`src/parsers/sources/wt-browser.ts`, `src/player-stats/statshark-client.ts`.

### P1.10. Устранить обход общего WT-limiter

**Статус: Частично, обход limiter закрыт.**

`wt-clans.ts` теперь использует общий `fetchWtResponse()`, поэтому leaderboard
запросы больше не обходят общий interval, Retry-After и выбор транспорта.
Отдельные recovery-проблемы browser pool всё ещё открыты.

Сделано:

- перевести `wt-clans` на `fetchWtResponse()`;
- убрать дублирование User-Agent и локального интервала;
- сохранить отдельный путь CDN binary fetch, которому браузер не нужен;

Осталось:

- добавить backoff между clearance probes и метрики probes;
- проверить, что общий limiter не голодает `wt-players`;

Файлы: `src/parsers/sources/wt-clans.ts`,
`src/parsers/sources/wt-request.ts`, `src/parsers/sources/wt-browser.ts`.

### P1.11. Зависимости и гигиена репозитория

**Статус: Почти готово.**

`@fastify/static` обновлён до безопасной major-версии, Discord/transitive
dependencies обновлены, `domhandler` добавлен напрямую. Первый прогон
`npm audit` 2026-07-29 показал 0 уязвимостей, Fastify SPA smoke проходит;
audit нужно повторить перед фиксацией lock-файла.

Сделано:

- обновить lock-файл с review каждого major bump;
- проверить совместимость `@fastify/static` с `/app`;
- обновить Discord/undici-транзитивы;
- добавить `domhandler` как прямую зависимость, если type import остаётся;
- добавить в `.gitignore` `data`, архивы и локальные env-файлы;
- добавить `.gitattributes` с LF и binary-правилом для replay;
- исправить NUL-байт в `src/web/routes/site.ts`, из-за которого diff видит
  файл как binary;
- не использовать `git add -A`, не добавлять `data`, backup, архивы, `.env`
  и build artifacts.

Осталось:

- отдельно решить судьбу уже tracked `frontend/tsconfig.tsbuildinfo`;
- перед коммитом ещё раз проверить explicit file list и отсутствие секретов.

Приёмка:

- `npm audit --omit=dev --audit-level=high` проходит или каждый remaining
  advisory имеет зафиксированную причину и mitigation;
- `git diff` для `site.ts` снова текстовый;
- `git status --porcelain -uall` не показывает неожиданные архивы и секреты.

### P1.12. Оформить сезонный контур

**Статус: Частично, продуктовый путь работает в текущей рабочей копии.**

Клановый сезон больше не является только UI-макетом: статическое расписание
влияет на рейтинговые baseline, site API/SPA и представление боя в Discord.

Сделано:

- добавить `CLAN_SEASON_SCHEDULES` с полуоткрытыми UTC-интервалами этапов;
- создать `clan_seasons` и `clan_season_stages`, seed-ить расписание при
  `initDb()`;
- ограничить dedupe/delta/baseline рейтингов началом текущего сезона;
- отдавать `getClanSeasonContext()` через `/api/stats`, `/api/site-stats`,
  `/api/clans` и clan detail;
- показывать этап и максимальный БР на Home/Clans/Clan и в `/battle`;
- проверить точные границы этапов unit-тестом и site API smoke.

Осталось:

- закрепить источник, владельца и процедуру обновления расписания до начала
  следующего сезона; сейчас в коде зафиксирован один сезон 2026 года;
- валидировать отсутствие пересечений/дыр, вхождение этапов в сезон и
  согласованность последнего этапа с `endsAt`;
- сделать `seedClanSeasons()` reconciliation-safe: удалённый или
  перенумерованный этап сейчас остаётся в SQLite, потому что seed выполняет
  только upsert;
- включить сезонные таблицы в полноценную versioned migration из P1.7;
- добавить regression test строки `/battle`, поведения между сезонами и
  frontend-состояний active/waiting/ended.

Файлы: `src/clan-season.ts`, `src/clan-season.test.ts`, `src/db/index.ts`,
`src/bot/commands/battle.ts`, `src/web/routes/api.ts`,
`src/web/routes/site.ts`, `frontend/src/components/SeasonPanel.tsx`,
`src/analysis/site-api-smoke.ts`.

## 5. P2. Данные, SQLite и долгий срок жизни

### P2.1. Добавить backup и retention policy

**Статус: Частично, ручной backup path добавлен.**

Нормализованные данные нужны долго, но `events_blob`, внешние snapshots и
клановые snapshots растут без общей политики.

Сделано:

- `db:backup` делает локальную копию с ротацией;

Осталось:

- внедрить ночной backup через внешний scheduler;
- хранить scoreboard бессрочно, если это продуктовый контракт;
- перенести старые `events_blob` в отдельный архивный SQLite-файл только после
  измерения и теста восстановления;
- добавить retention для `clan_rating_snapshots` и
  `player_external_snapshots`;
- вынести cleanup из транзакции `saveItems`;
- ограничить `getClanRatingsWithDelta` параметром периода и LIMIT;
- добавить стартовую уборку stale `data/battles/*.tmp`.

### P2.2. Отделить `events_blob` от строки `battles`

**Статус: Отложено до измерения.**

`events_blob` фрагментирует b-tree и делает полные проходы дорогими. После
закрытия P0.4 и получения baseline сравнить:

- отдельную таблицу `battle_events(session_id PRIMARY KEY, events_blob)`;
- миграцию в offline-окне;
- время lookup, backup, `quick_check`, cold warmup и размер файла.

Не выполнять миграцию только по теоретической оценке. Сначала подтвердить,
что выигрыш оправдывает разовую операцию над многогигабайтной БД.

### P2.3. Версионировать и разделить DB API

**Статус: Частично, разделение отложено.**

`src/db/index.ts` уже содержит большинство DB API, но остаётся большим
монолитом с ручным сбросом prepared statements.

Порядок:

1. завершить migration registry из P1.7 и отделить clean bootstrap;
2. следующим шагом добавить registry для statement cache;
3. затем механически разделить `connection`, `schema`, `migrations`,
   `items`, `battles`, `players`, `voice`, `clans`, `site`;
4. после каждого переноса запускать build, test, site smoke и EXPLAIN.

Не менять синхронный DB API и не начинать миграцию на async Postgres в рамках
этого плана.

## 6. P2. Worker, cache и benchmark

### P2.4. Расширить benchmark до cache и parse phases

**Статус: Частично.**

Corpus, cold/warm render, queue, transfer, execution, RSS и event-loop lag уже
сохраняются. Не хватает:

- cache lookup/read/write;
- atomic rename и eviction scan;
- cache hit/miss/corrupt/evicted bytes по `BattleMediaKind`;
- чтения `events_blob`;
- фаз header/results BLK, packet stream, ECS/GMSync/FM, extraction, transform,
  gzip;
- plateau/recycle-теста RSS после длинной серии.

Сначала снова зафиксировать актуальный corpus после того, как тесты и текущий
render drift будут оформлены в коммитах.

### P2.5. Admission control и подбор размера worker-пула

**Статус: Открыто.**

После P0.3:

- добавить оценку веса parse, PNG, 2x PNG и bundle;
- учитывать output pixels/bytes и native memory;
- ограничить запуск по свободной RAM с hysteresis;
- публиковать queue length, wait, execution, timeout stage, startup,
  replacement reason и RSS;
- измерить 1/2/3/4 workers для одиночной latency и 2/4 параллельных боёв;
- отдельно измерить ingest throughput;
- подтвердить, что ротация после 12 render jobs лучше по memory plateau, чем
  её cold-start стоимость;
- не клонировать полный blob и assets между workers без измеренного выигрыша.

### P2.6. Battle-cache

**Статус: Частично.**

Уже есть атомарная публикация, LRU, marker и версионирование renderer options.
Открыто:

- лёгкий in-memory каталог `{ session, bytes, lastAccess }`;
- reconciliation при старте;
- версия assets, карт, шрифтов и unit icons;
- hit/miss/corruption/eviction metrics;
- idle prewarm только для часто запрашиваемых материалов и только при
  свободном CPU/RAM budget.

Не возвращать фоновую сборку полного bundle для каждого cache miss одного
материала.

## 7. P3. WRPL, SVG и потенциальные native решения

### P3.1. Безопасные parser fixtures

**Статус: Частично.**

`src/wrpl/binary-bounds.test.ts` уже проверяет выход BitReader за границы,
слишком длинный varint, некорректную uint32-маску, обрезанные LZ4 length/offset,
VROMFS header/size/tables и FAT BLK varint/descriptions/tree cycles. Эти
fixtures входят в обычный `npm test`.

Осталось добавить damaged/truncated full WRPL, packet stream, ECS/GMSync и
публичные decompression-limit fixtures, включая превышение разрешённого
output. Каждый случай должен завершаться доменной ошибкой или bounded result,
не зависанием и не OOM; execution-timeout остаётся последним предохранителем,
а не заменой bounds-check.

### P3.2. Профилировать TypeScript parser

**Статус: Открыто.**

Сначала собрать CPU profile и пофазные p50/p95 на corpus. Оптимизировать только
фазы, которые дают заметную часть parse p95. После каждого изменения проверять
players, kills, chat, winner, trajectories, DB rows и events blob.

### P3.3. Геометрия и SVG

**Статус: Отложено.**

Текущая SVG-фаза заметно меньше Resvg init и не является P0. Возвращаться к
ней только по profile:

- spatial index для collision подписей и markers;
- повторное использование неизменяемого background;
- сокращение промежуточных массивов;
- `Float32Array` только при подтверждённом выигрыше RSS/transfer.

Сохранить текущие индексы убийств, binary search и PreparedHeatmapScene.

### P3.4. Rust и GPU

**Статус: Отложено.**

Rust prototype разрешать только если один устойчивый CPU-кластер занимает не
менее 20% parse p95. Требование к prototype: минимум 15% end-to-end выигрыша
или двукратное ускорение целевой фазы без роста RSS, с сохранением fixtures,
fuzz-тестов, Windows/Linux binaries и AGPL-атрибуции.

GPU не начинать, пока raster/encode не станет не менее 30% p95 или не появится
подтверждённый throughput bottleneck при параллельных боях. CPU Resvg должен
остаться fallback.

## 8. Тесты, CI и процесс

### 8.1. Сделать настоящий offline verify

**Статус: Открыто.**

Сейчас `npm test` запускает только `src/**/*.test.ts`. Офлайн smoke для DB,
web, player stats, player board и workers выполняются вручную.

Сделать:

- сделать token/config lazy, чтобы тесты не требовали реального Discord token;
- добавить тестовый glob для `*.test.ts` и `*.spec.ts`;
- убрать `**/*.spec.ts` из tsconfig exclude;
- исключить `**/*.test.ts` из production `dist`;
- добавить `npm run verify` с `npm test`, build и всеми offline smoke;
- live probes оставить отдельными и включать только явным флагом;
- добавить `.github/workflows/ci.yml` с `npm ci`, `npm run build`,
  `npm run build:web`, `npm run verify` и npm audit.

Пока эта задача не закрыта, зелёный `npm test` недостаточен как regression
signal для DB/web/worker layers.

### 8.2. Тесты на основные неисследованные слои

**Статус: Частично.**

Уже добавлены:

- migration tests на чистой, legacy, неизвестной новой и заблокированной БД;
- startup DB guard и rollback незавершённой migration version;
- web inject tests на bearer auth, CSRF и safe 500, а smoke покрывают 4xx и
  rate-limit;
- parser backoff/scheduler lifecycle и source-level `wt-replays` fixtures;
- базовые binary bounds для BitReader/LZ4/VROMFS/BLK;
- official-profile/StatShark normalizers, player-stats API/cache/delta и
  ambiguity smoke.

Осталось добавить:

- `src/db/announce.test.ts`: exactly-once, attempts, baseline monotonicity;
- process-level fatal/startup test из P0.2 и migration-registry test из P1.7;
- worker scheduler tests с fake worker factory и fake clock;
- оставшиеся full WRPL/ECS/GMSync/decompression boundary tests из P0.5/P3.1;
- player-stats identity/normalizer regressions из P1.8;
- многоигроковые render fixtures с ненулевыми значениями, сортировкой и
  overflow на 32 игрока;
- test для `vehicleDictPromise`, чтобы отказ не кэшировался навсегда;
- frontend error/season-state tests после добавления test setup.

### 8.3. Зафиксировать baseline и коммиты

**Статус: Частично, baseline зелёный, рабочая копия не разложена.**

Перед продолжением:

1. сохранить текущие изменения сезона и аудита явными тематическими коммитами
   или согласованным способом, не используя `git add -A`;
2. подтвердить, что исправленный `src/web/routes/site.ts` остаётся текстовым;
3. отдельно решить судьбу tracked `frontend/tsconfig.tsbuildinfo`, не смешивая
   его build-drift с продуктовым diff;
4. проверить `.gitignore`, `.env`, `data`, архивы и build output;
5. перед каждым commit выполнять `git status`, `git diff --cached` и проверку
   секретов;
6. после каждого commit повторять build, test и затронутый verify.

Рекомендуемые группы:

1. репозиторий и test/CI infrastructure;
2. web auth/error handling;
3. DB index, migrations и backup;
4. parsers, browser recovery и binary safety;
5. worker pool и performance instrumentation;
6. product features.

## 9. Продуктовый roadmap после P0/P1

### 9.1. Ветка боя

**Статус: Открыто. Приоритет: высокий для сайта.**

`game_mode` описывает реализм, а не Air/Ground. На ingest вычислять
`air`/`ground`/`mixed` из `battle_players.vehicles` и словаря
`data/wt-vehicles.json`, хранить в `battles.branch`, отдавать в list payload и
фильтровать на сервере.

Минимальный промежуточный фикс: убрать ложные Air/Ground фильтры и показывать
честный realism badge до появления `branch`.

### 9.2. Метастатистика техники

**Статус: Открыто, данные уже есть.**

Создать агрегаты по vehicle, class, country, map и weapon:

- win rate и K/D по технике;
- killer versus victim matrix;
- эффективность оружия;
- выбор техники по карте.

Считать агрегаты на ingest или пакетным фоном, не по HTTP-запросу.

### 9.3. Клан против клана и карты

**Статус: Открыто, предусловия в данных есть.**

После исправления roster correctness добавить историю встреч, серии и средние
результаты клана против клана. Для карт добавить словарь `level`/mission id в
человеческие названия и затем рейтинг карт, длительность и точки смертей.

### 9.4. Чат и внешняя статистика

**Статус: Не включать сейчас.**

Чат нельзя отдавать публично до auth, privacy-решения и явного API-контракта.
Внешнюю account-статистику сначала либо довести до рабочего transport/provider
с реальными данными, либо заморозить. Существующие условные account-разделы
`PlayerPage` не позиционировать как полные и не расширять, пока
`player_external_totals` и `player_external_vehicles` не имеют подтверждённого
наполнения.

### 9.5. Не планировать по текущим данным

Аналитику отрядов не обещать: `squad_id` не является подтверждённым squad
идентификатором. Postgres, полный rewrite, Rust для всего приложения и GPU
рендер не являются самостоятельными целями.

## 10. Улучшения frontend

**Статус: Частично, основные error-state и сезонный UI уже добавлены.**

Основные страницы используют `SiteApiError`, `ErrorNotice` и отдельные
loading/error состояния; Home/Clans/Clan показывают `SeasonPanel`. При этом
часть вторичных запросов истории/rank всё ещё глотает ошибку через пустой
`catch`, а frontend test setup отсутствует.

Осталось:

- убрать silent fallback вторичных запросов и показывать различимые
  loading/empty/error состояния;
- не кэшировать отказ `vehicleDictPromise`;
- расширить ETag/Cache-Control за пределы уже кэшируемого `/api/vehicles`;
- добавить `@fastify/compress` после проверки совместимости и audit;
- исправить rank/delta на странице клана, не вычислять их через список,
  обрезанный до 100;
- добавить пагинацию/`show more` для battles;
- остановить постоянный `requestAnimationFrame` на статичной сцене;
- добавить `aria-pressed` и arrow-key navigation в уже семантические
  `button`-элементы `SegControl`;
- добавить scroll restoration;
- рассмотреть route-level lazy loading после измерения initial bundle;
- self-host fonts, если это нужно для privacy и первого рендера.

## 11. Итоговый порядок выполнения

```text
1. Зафиксировать текущую незакоммиченную работу и baseline.
2. Закрыть process-level fatal/startup smoke.
3. Довести migration registry и reconciliation сезонного расписания.
4. Завершить binary parser/decompression bounds и regression fixtures.
5. Измерить session_hex/site SQL на реальной БД и убрать request-time clan
   snapshot/replay-player count.
6. Исправить clan roster fallback и сезонную корректность рейтингов.
7. Исправить player-stats correctness и решить судьбу внешних провайдеров.
8. Завершить browser/statshark recovery и проверить fairness общего WT-limiter.
9. Собрать единый offline verify, сделать config lazy, добавить CI и повторить
   dependency audit.
10. Определить retention/events_blob architecture и длительный benchmark.
11. Добавить worker admission control, профилировать parser и только затем
    рассматривать Rust/GPU.
12. Product roadmap: branch, vehicles, clans, maps.
```

## 12. Definition of Done

Считать базовый этап закрытым только когда:

- web по умолчанию слушает loopback и защищён при non-loopback;
- 5xx безопасны для клиента и видны в логах;
- fatal/startup path подтверждён отдельным process-level smoke;
- worker auto/explicit plan никогда не превышает лимит;
- lookup по battle id не делает `SCAN battles`;
- повреждённый бинарный input bounded и не расходует retry как обычная ошибка;
- есть проверенный backup и процедура восстановления;
- структурные изменения SQLite не обходят migration registry;
- сезонное расписание валидируется, воспроизводимо seed-ится и имеет
  процедуру обновления;
- плановый WT poll имеет cap и backoff;
- `npm run build`, `npm test`, `npm run build:web`, offline verify и worker
  dist smoke зелёные;
- npm audit не имеет незакрытых high advisory без письменного решения;
- рабочие изменения разложены по тематическим коммитам, без секретов,
  архивов, `data` и случайных build artifacts;
- performance baseline содержит cache, parse, render, queue и memory phases;
- ни одна новая оптимизация не возвращает синхронный тяжёлый путь в main thread.
