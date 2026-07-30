# План производительности wtbot

Обновлено: 2026-07-30.

Статус: измерительный контур и no-regret оптимизации закрыты; process-wide
replay budget, memory-aware worker sizing и controlled WAL checkpoint
реализованы. Текущий пакет P4-A добавил точный eligible backlog, rollback-safe
AIMD для CDN/ingest и экспериментальный exact replay reservation. По прямому
указанию владельца 30.07.2026 30-минутный live soak не выполняется и больше не
является обязательным gate; staged ingest и SQLite writer остаются условными,
пока короткая bounded telemetry либо controlled fixture не покажет их пользу.

Этот документ содержит только актуальные решения, подтверждённые baseline,
открытые bottleneck, порядок исполнения и regression gates. Источники истины:
текущий код и схема БД, затем `AGENTS.md`; продуктовый roadmap —
`MASTER_PLAN.md`. Сырые локальные результаты находятся в
`data/benchmarks/`.

## Разрешение на performance-работы

Владелец проекта 29.07.2026 разрешил в рамках этого плана:

- запускать development/production-сборку bot, web, parser/ingest и browser
  transport;
- выполнять сетевые canary/backfill;
- писать в локальную SQLite и восстанавливаемые кэши;
- менять локальную performance-конфигурацию и собирать профили.

Перед live-запуском обязательно исключать случайный автоанонс: процессу
передаётся пустой `WT_BATTLES_CHANNEL`. Разрешение не включает регистрацию
Discord-команд, платные AI-запросы, destructive restore/delete и публикацию
секретов из `.env`.

## Итог исследования

Цель — не 100% host CPU/RAM, а максимальный устойчивый ingest throughput при
сохранении Discord/Fastify latency, bounded memory и корректности данных.

Почему CPU и RAM не заполняются полностью:

- discovery-запросы warthunder.com намеренно проходят через общую
  последовательную очередь с интервалом 1500 мс и `Retry-After`;
- CDN download, retry и SQLite — I/O waits, которые CPU workers не устраняют;
- `node:sqlite` в main thread синхронна, поэтому тяжёлый SELECT блокирует bot,
  даже если остальные ядра свободны;
- один физический CPU также обслуживает main thread, Discord/Fastify,
  transfer/GC, render, SQLite и ОС;
- заполнение RAM вытесняет SQLite/page cache и создаёт swap/OOM вместо
  throughput.

Текущий локальный production-профиль подтверждён коротким live A/B:

| Параметр | Значение |
| --- | ---: |
| `WT_WORKER_THREADS` | 5 |
| `WT_WORKER_BACKGROUND_RESERVE` | 1 |
| Активные background CPU slots | 4 |
| `WT_WORKER_ESTIMATED_MB` | 320 |
| `WT_INGEST_CONCURRENCY` | 8 |
| `WT_REPLAY_PROCESS_BUDGET_MB` | 384 |
| Production hard cap workers | 8 |

Решения по worker count:

- `5 workers / 4 background jobs` — основной профиль bot+web+ingest;
- `6/5` даёт около +7,7% synthetic throughput, но ухудшает parse p95 примерно
  на 20%, render p95 на 17% и RSS на 15,5%;
- `6/4` статистически совпадает с `5/4`: шестой созданный worker не является
  причиной регрессии, цена возникает от пятой активной background-задачи;
- 8 workers показали максимум только в worker-only parse+render benchmark.
  Это не доказательство преимущества в end-to-end ingest и не основание
  менять live bot;
- экспериментальные 9 workers медленнее 8 на длинном production-render
  benchmark; временный cap удалён, hard cap остаётся 8.

## Что уже реализовано

| Область | Актуальное состояние |
| --- | --- |
| CPU pool | До 8 workers; interactive/normal/background priority, reserve, queue count и transferable bytes, queue/execution timeout, worker replacement, bounded current/high-water/cumulative telemetry |
| Auto resources | Default estimate 320 МиБ; CPU, free RAM, OS reserve, workers и replay buffers планируются совместно |
| Replay download | Любое число replay parts, но не более двух одновременных CDN download на бой; retry/dedup/abort, общий `Retry-After`, adaptive fetch interval 150–2000 мс за default-off rollback-switch, 96 МиБ на часть, 512 МиБ на бой |
| Process replay budget | FIFO byte semaphore; default worst-case reservation выдаётся до I/O и уменьшается до actual bytes; экспериментальный exact-режим резервирует проверенный cache size либо network peak до `min(2 × Content-Length, 96 МиБ)`; timeout/abort wait входит в telemetry |
| Ingest telemetry | Bounded stages eligible/download/ready/parse/persist, count/bytes/wait, battles/min, точный eligible backlog, bounded oldest-age, TTFB/download/retry/status и process-budget wait/high-water |
| Adaptive admission | Default-off AIMD уменьшает ingest concurrency по новым 429/5xx/retry, replay-budget и persist pressure; recovery идёт по stable window/cooldown, состояние и reason публикуются в telemetry |
| Backlog read model | `getIngestStats().pending` эквивалентен retryable predicate выборки; exhausted errors исключены, `events_blob` не читается, production p95 8,03 мс |
| Benchmark corpus | Четыре постоянных сценария в `benchmarks/fixtures/replays`; byte/SHA-256, success/error и normalized output contract; runtime LRU-cache запрещён verifier-ом |
| Media | Air variants не строятся без air events; неизвестный winner не запускает background full bundle; winner update bounded/coalesced |
| Read model боя | Nullable `air_unit_count`/`chat_count`, migration v3, индексированный `getBattlePostSummary()` без чтения `events_blob` |
| SQLite ingest | Commit сериализован и выполняется вне main thread; worker connections/statements кэшируются; passive checkpoint — раз в 32 commit/60 с на connection и явно при shutdown |
| SQLite warmup | Blocking startup warmup сокращён с 24 840 до 43 мс; тяжёлые table scans выполняются в read-only worker |

Текущая незакрытая архитектурная связь: один runner в `ingestBatch()` держит
свой concurrency slot через download → parse → serialized persist.
`loadBattleData()` также используется интерактивным render path, поэтому
разделять его нужно совместимо, без изменения `/battle`.

## Подтверждённые baseline

Среда controlled benchmark: AMD Ryzen 5 3600X, 6 physical/12 logical CPU,
Windows x64, AMD Ryzen Balanced, Node.js 24.11.0.

### Корректность и измерения

- исторический baseline до текущего пакета: **106 pass, 0 fail**; текущий
  baseline после 14 новых regression tests: **120 pass, 0 fail**;
- `npm run build`, `verify:workers`, `verify:workers:dist`, `verify:site-db` и
  `verify:benchmark-corpus` проходят;
- ingest telemetry overhead: p50/p95 около 0,0008 мс на lifecycle, то есть
  примерно 0,0008% консервативного бюджета 100 мс;
- snapshot после 100 000 lifecycle — 3855 bytes: cardinality bounded;
- corpus:
  - small mixed — 2,59 МиБ, 36 trajectories;
  - large ground-only — 5,21 МиБ, 220 trajectories;
  - large mixed-air — 11,81 МиБ, 37 trajectories;
  - damaged — ожидаемый `results-BLK` error;
- replay descriptors, normalized hashes и PNG SHA-256 стабильны во всех
  worker sweeps.

### Live ingest

Короткий A/B после process budget:

| Профиль | Commit | HTTP 429 | Дополнительные факты |
| --- | ---: | ---: | --- |
| auto 3 workers, ingest 14 | 12 | 26 | baseline |
| 5 workers, ingest 8, replay 384 МиБ | 15 | 5 | +25% commit, −81% 429 |

Во втором tuned canary `/health`, `/api/stats`, `/api/items` и `/api/voice`
остались ≤36,4 мс, process-budget wait был равен нулю, shutdown прошёл
штатно. Это положительный короткий сигнал; долговременные RSS plateau и
error/retry rate не доказаны. 30-минутный soak не запускается по решению
владельца, поэтому это ограничение явно сохраняется в decision gate.

### Точный snapshot очереди

Read-only snapshot production SQLite от 30.07.2026:

| Метрика | Значение |
| --- | ---: |
| Всего `wt-replays` items | 23 399 |
| Eligible backlog по тому же predicate, что ingest | **473** |
| Exhausted `error`, attempts = 3 | 17 |
| `expired` | 23 |
| `ok` | 22 886 |
| `battle_ingest` без соответствующего replay item | 0 |

Старая формула показывала 490, потому что считала 17 exhausted errors частью
очереди, хотя `getPendingBattleItems()` их уже никогда не выбирал. Новый
агрегат считает 473 и использует только `battle_ingest`, covering index
`idx_items_source_updated` и covering index `idx_battles_metrics`; production
замер 100 read-only вызовов: p50 6,71 мс, p95 8,03 мс, p99 8,71 мс,
max 8,90 мс. `EXPLAIN QUERY PLAN` не читает `battles.events_blob`.

### Authoritative worker baseline

Decision baseline — 30-секундный closed-loop large mixed-air,
parse + production-priority `heatmap-air`, один interactive slot
зарезервирован. Короткие 10-секундные sweeps считаются exploratory и не
используются для выбора production profile.

| Workers / jobs | Throughput | Parse p95 | Render p95 | Render queue p95 | Peak process RSS | Event-loop signal p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 / 3 | 1,738/с | 1584 мс | 293 мс | 0,056 мс | 970 МиБ | 23,3 мс |
| 5 / 4 | 2,064/с | 1803 мс | 325 мс | 0,054 мс | 1216 МиБ | 33,1 мс |
| 6 / 5 | 2,236/с | 2190 мс | 400 мс | 0,066 мс | 1404 МиБ | 36,2 мс |
| 7 / 6 | 2,359/с | 2359 мс | 393 мс | 0,281 мс | 1652 МиБ | 30,2 мс |
| 8 / 7 | **2,412/с** | 2903 мс | 465 мс | 0,141 мс | 1911 МиБ | 52,4 мс |
| 9 / 8, experiment | 2,369/с | 3386 мс | 617 мс | 0,211 мс | 2104 МиБ | 47,5 мс |

Event-loop timer внутри synthetic saturation используется как сравнительный
signal, а не как live SLO: Windows scheduling даёт шум и немонотонные
значения. Live event-loop/API latency измеряется отдельно.

Повторная проверка точки 6:

| Режим | Результат |
| --- | --- |
| `5/4` | median 2,061/с; parse/render p95 1867/325 мс; RSS 1216 МиБ |
| `6/4` | 2,004–2,045/с; p95 1847–1871/338–340 мс; RSS 1213–1243 МиБ |
| `6/5` | median 2,220/с; p95 2242/380 мс; RSS 1405 МиБ |

Вывод: размер пула 6 безопасен, но `reserve=1` открывает пятую background
задачу. `6 workers + reserve 2` не показал преимущества над более простым
`5 workers + reserve 1`.

### Replay I/O

Локальный HTTP fixture, small corpus:

| Concurrency частей одного боя | Cold p50/p95 | Peak RSS delta p95 |
| --- | ---: | ---: |
| 1 | 1163/1171 мс | 10,3 МиБ |
| 2 | 879/910 мс | 7,8 МиБ |
| 3 | 730/864 мс | 7,8 МиБ |

Production остаётся на concurrency 2: относительно 1 это около +24% по p50;
retry, fatal cancellation, explicit abort, per-battle cap и duplicate dedupe
проходят. Третий runner не увеличил фактический peak выше двух в fixture и
не имеет live A/B. CDN binary download не должен идти через browser transport.

### SQLite persist/checkpoint

До исправления каждый commit выполнял `wal_checkpoint(PASSIVE)`.
Live-инструментация показывала 835–954 мс SQLite, включая 356–489 мс
checkpoint при transaction 346–537 мс.

Controlled temporary SQLite:

| Режим | Commit p50/p95 | Изменение |
| --- | ---: | ---: |
| Checkpoint после каждого боя | 7,2/7,9 мс | baseline |
| Checkpoint раз в 32 commit/60 с | 3,4/4,2 мс | −53%/−47% |

После изменения обычный live commit имел `checkpoint=0`; shutdown checkpoint
выполнился внутри worker. Соединения всё ещё распределены по CPU workers, а
каждая транзакция сохраняет только один бой — это следующий возможный DB
bottleneck, но его приоритет должен подтвердить soak.

### Устранённая media-работа

- неизвестный winner больше не создаёт полный bundle в фоне;
- ground-only не создаёт air variants;
- ранее устраняемый warm bundle стоил 712/762 мс p50/p95 на ground-only и
  1344/1404 мс на mixed-air;
- ingest при необходимости строит только scoreboard update, остальные media
  создаются по запросу.

## Открытые bottleneck

| Приоритет | Проблема | Риск/следствие |
| --- | --- | --- |
| Gate | Долгий live soak снят по прямому указанию владельца | Нет доказательства долговременного RSS plateau; крупные архитектурные пакеты требуют bounded canary либо controlled fixture |
| P0 | Один ingest slot охватывает download, parse и persist | Медленная стадия удерживает admission другой стадии |
| P0 | Нет одного SQLite writer/microbatch | Однобоевые транзакции не амортизируются, connections распределены по CPU workers |
| P1 | Persist output, PNG и native Resvg memory не входят в weighted budget | Replay cap не гарантирует общий RSS plateau |
| P1 | P4-A AIMD default-off и ещё не использует TTFB/RSS/output/native memory | Без отдельной калибровки нельзя включать его по умолчанию или считать weighted admission завершённым |
| P2 | Newest-first без полноценного aging | Старый backlog может ждать при постоянном потоке новых items |
| P2 | Синхронные SQLite read models | SELECT >10 мс может остановить Discord heartbeat/Fastify |
| P3 | Нет полного CPU profile WRPL phases | Оптимизация parser/Rust пока не имеет доказанного hot phase |
| P4 | Нет cache catalog/fingerprint и fairness WT source queue | Стабильность и observability, но не доказанный текущий throughput limiter |

Таблица `battles` содержит большой `events_blob`; full scan недопустим.
Любой изменённый SQL обязан пройти `EXPLAIN QUERY PLAN`. Read path, устойчиво
превышающий 10 мс, переносится в snapshot/read-only worker либо получает
индекс — не маскируется увеличением workers.

## Текущий decision gate без 30-минутного soak

В этой итерации обязательный gate закрывается точным read-only snapshot
очереди, offline regression suite и bounded instrumentation. Долгий live run
не выполнялся. Если для следующего решения всё же понадобится короткая живая
проверка, используется `npm run benchmark:performance-soak` с текущим профилем
5 workers / reserve 1 / ingest 8 / replay 384 МиБ. Harness по умолчанию
ограничен 5 минутами, принимает `--duration-minutes`, принудительно очищает
`WT_BATTLES_CHANNEL` и сохраняет raw/summary/shutdown JSON.

Во время bounded canary снимать:

1. Каждые 30 секунд:
   - process RSS/heap/external/arrayBuffers;
   - worker active/queued/high-water по priority и kind;
   - ingest stage count/bytes/wait, exact backlog, bounded oldest age и
     battles/min;
   - replay budget used/queued/high-water/wait;
   - CDN TTFB/download/retry/status/429/5xx;
   - SQLite queue/transaction/checkpoint;
   - event-loop lag и latency `/health`, `/api/stats`, `/api/items`,
     `/api/voice`.
2. Остановить процесс graceful shutdown и проверить producer drain,
   worker-side checkpoint, отсутствие watchdog/fatal и оставшегося Node на
   порту 3000.

Decision gate по результату:

| Наблюдение | Первый пакет |
| --- | --- |
| Backlog есть, CPU background occupancy низкая, download/ready удерживает ingest slots | Staged download → ready → parse |
| Persist wait/SQLite queue устойчиво занимает значимую долю end-to-end p95 | Dedicated writer + microbatch |
| 429/retry/TTFB растут раньше CPU/persist saturation | AIMD admission; pipeline concurrency не повышать |
| RSS после warmup не выходит на плато либо output/native memory доминирует | Weighted memory admission + hysteresis |
| CPU стабильно насыщен, queues/RSS/SLO нормальны | WRPL phase profile до дальнейшей параллельности |

Если несколько условий выполняются одновременно, сначала устраняется
backpressure, создающий самый большой вклад в `discovered → committed` p95.

## Roadmap исполнения

### G1 — representative evidence: долгий soak отменён

- [x] 30-минутный run снят владельцем 30.07.2026; не запускать его как
  обязательную проверку.
- [x] Зафиксирован точный непустой backlog: 473 eligible боя; 17 exhausted
  errors исключены.
- [x] Добавлен bounded harness с raw telemetry, JSON summary, shutdown
  telemetry и default duration 5 минут.
- [ ] Короткий canary запускать только когда он нужен для конкретного решения;
  в текущей итерации live run не выполнялся.
- [ ] Долговременные RSS slope/plateau и error/retry rate остаются неизвестны и
  не должны подменяться коротким результатом.

### P2A — staged download/ready/parse: условный P0

Выполнять первым только если bounded live telemetry либо controlled fixture
подтверждает lifecycle coupling.

1. Добавить rollback-switch `WT_INGEST_PIPELINE_ENABLED`; одновременно
   обновить `src/config.ts`, `.env.example` и `AGENTS.md`.
2. Сохранить публичный `loadBattleData()` для `/battle`; ingest-specific path
   разделить на prepare/download и parse/consume.
3. Ввести bounded ready queue по count и retained actual bytes. Existing
   process byte reservation передаётся вместе с replay и освобождается только
   после parse/error/abort/shutdown.
4. На первой итерации оставить существующий serialized one-battle persist:
   writer не смешивать с pipeline diff.
5. Добавить high/low watermark producer pause/resume и отдельные reason codes.
6. Проверить fatal sibling cancellation, queue timeout, admission defer,
   worker replacement, graceful drain и replay-cache delete only after commit.

Изменяемые точки: ingest-specific API рядом с `loadBattleData()`,
`ingestOne()/ingestBatch()`, telemetry transitions и новый bounded queue
helper. Перед общей функцией повторно проверить обоих callers:
`ingestOne()` и интерактивный `loadBattleRenderSource()`.

### P2B/P3 — persist queue и dedicated SQLite writer: условный P0

Выполнять после P2A либо первым, если bounded telemetry показывает
доминирующий persist wait.

1. Bounded persist queue по count и serialized `events_blob` bytes.
2. Один dedicated writer actor, одно соединение, cached statements.
3. Microbatch 4–16 боёв либо максимум 50–100 мс ожидания.
4. Одна атомарная transaction; rollback и безопасное деление batch при
   повреждённой записи.
5. Passive checkpoint по commit/time и фактическому WAL size; явный shutdown
   checkpoint.
6. Не менять `synchronous=FULL/NORMAL` без отдельного durability-решения и
   controlled temporary-DB benchmark.

### P4 — adaptive и weighted admission: P4-A реализован

- [x] AIMD ingest concurrency по новым 429/5xx/retry, replay-budget wait/queue
  и persist pressure за `WT_INGEST_ADAPTIVE_ENABLED=false`.
- [x] Adaptive CDN interval 150–2000 мс и process-wide `Retry-After`; общий
  limiter не ослаблен.
- [x] Recovery по stable samples и cooldown без oscillation; pressure reason
  сохраняется в snapshot.
- [x] Timeout/abort replay-budget wait учитывается в cumulative telemetry и не
  расходует ingest attempts.
- [x] Экспериментальный exact cache/Content-Length reservation за
  `WT_REPLAY_EXACT_RESERVATION_ENABLED=false`; default сохраняет pre-I/O
  worst-case admission.
- [ ] Добавить TTFB/RSS/output/native-memory signals только после отдельной
  калибровки, не по одному короткому run.
- [ ] Aging backlog при сохранении newest-first для CDN expiry.
- [ ] Weight по task kind/input/pixels/output/native peak.
- [ ] Удерживать output buffers в budget до фактического освобождения.
- [ ] Reason codes различают network defer, memory defer, queue overflow,
  execution timeout и worker replacement.

Общий limiter warthunder.com 1500 мс и `Retry-After` не ослаблять. AIMD для
CDN/ingest не должен позволять новому source обходить `fetchWtResponse()`.

### P5 — CPU profile и точечные оптимизации

- [ ] Header/results BLK, packet stream, ECS/GMSync/FM, extraction,
  transform и gzip как отдельные phases.
- [ ] CPU profile внутри worker на полном corpus.
- [ ] Менять только phase с долей ≥20% parse p95.
- [ ] Rust/napi-rs рассматривать при prototype gain ≥15% end-to-end либо
  ≥2× подтверждённой hot phase.

Bounds-check недоверенного WRPL, output limits и worker execution timeout
не ослаблять ради benchmark.

### P6 — вторичные улучшения

- [ ] Cache hit/miss/corrupt/evicted bytes и asset fingerprints.
- [ ] Fair WT source queue без обхода общего limiter.
- [ ] Read snapshots для оставшихся sync query >10 мс.

## Методология и regression gates

Не смешивать разные baseline:

- worker/pool change сравнивается с 30-second `5/4` parse+heatmap baseline;
- staged ingest сравнивается с одинаковым bounded canary и controlled
  CDN/SQLite fixture;
- writer change сравнивается на временной SQLite и затем live canary;
- media change сравнивается на одинаковом corpus и variant;
- live CDN результаты не используются как точный controlled throughput A/B.

Правила статистики:

- короткий 10-second run — только exploratory;
- decision run — не менее 30 секунд и достаточный sample count;
- ожидаемая разница <10% требует минимум трёх interleaved/reversed-order
  повторов; единичный результат считается шумом;
- сравниваются median runs и p50/p95, а не лучший прогон;
- `process.memoryUsage().rss` в worker threads — RSS всего процесса; значения
  threads не суммируются.

Приёмка изменения:

- primary bottleneck metric улучшается минимум на 10% либо oldest-age/p95
  уменьшается минимум на 20%;
- throughput regression по несвязанному controlled path ≤5%;
- players/kills/chat/winner/trajectories/rows/events и media hashes не
  меняются;
- queued/reserved bytes никогда не превышают hard limits;
- timeout/abort/error/shutdown освобождают reservations и gauges;
- retry-neutral backpressure не расходует ingest attempts;
- 429/5xx/retry не ухудшаются относительно tuned live baseline;
- process RSS выходит на плато без swap/OOM;
- interactive worker queue p95 <100 мс, p99 <250 мс;
- live event-loop p95 <20 мс, p99 <50 мс;
- `/health` и cached API p95 <50 мс;
- sync SQLite query >10 мс не добавляется в request path без
  snapshot/worker/index.

Большое архитектурное изменение не принимается только ради числа throughput:
оно должно пройти rollback-switch и показать пользу выше measurement noise.

## Проверка, rollout и rollback

Для каждого пакета:

1. Targeted tests изменённого модуля.
2. `npm test` против текущего baseline 120/120.
3. `npm run build`.
4. Worker/WRPL/render: `verify:workers` и `verify:workers:dist`.
5. SQL: targeted DB test, `EXPLAIN QUERY PLAN`, `verify:site-db`.
6. Corpus: `verify:benchmark-corpus`; при отсутствии fixtures сначала
   `restore:benchmark-corpus`.
7. Writer benchmark — только временная SQLite до live canary.
8. A/B — одинаковые code/config/corpus, interleaved order, cold/warm p50/p95,
   throughput, queue wait, RSS и hashes.
9. Live canary — без autoannounce; проверить endpoints, Discord ready,
   parser/ingest telemetry, watchdog/fatal/429 и duplicate item writes.

Rollback выполняется, если primary metric не улучшился выше noise, API/event
loop вышли из SLO, RSS не достигает плато, retry вырос либо изменилась
семантика данных.

## Ключевые артефакты

- corpus и telemetry:
  - `benchmarks/replay-corpus.json`;
  - `data/benchmarks/performance-phase-0-telemetry-overhead.json`;
  - `data/benchmarks/performance-phase-0-corpus-{fixed,duration,open-loop}.json`;
- no-regret/media:
  - `data/benchmarks/performance-phase-1-eliminated-bundle.json`;
  - `data/benchmarks/performance-phase-1-summary-fields.json`;
- replay budget:
  - `data/benchmarks/performance-phase-2-replay-byte-budget.json`;
- SQLite:
  - `data/benchmarks/performance-phase-3-checkpoint-every-battle.json`;
  - `data/benchmarks/performance-phase-3-checkpoint-batched.json`;
- authoritative workers:
  - `data/benchmarks/performance-phase-4-confirm30-render-workers{4,5,6,7,8,9}.json`;
  - `data/benchmarks/performance-phase-4-six-recheck-{w6j5,w6j4,w5j4}-r{1,2}.json`;
  - `data/benchmarks/performance-phase-4-auto-after.json`;
- live:
  - `data/benchmarks/live-phase-{b,c,d}.{out,err}.log`.

Exploratory worker sweeps сохранены в `data/benchmarks/`, но не являются
decision baseline.

## Отложено

Без новых измерений не выполнять:

- Postgres или полный rewrite «ради скорости»;
- 100% CPU/RAM любой ценой;
- увеличение live workers выше 5 только по synthetic throughput;
- снятие interactive reserve;
- ослабление bounds-check, decompression/output limits или timeout;
- `synchronous=NORMAL` без durability-решения;
- новый `events_blob`, пока decode не превышает 10% render p95;
- GPU, пока raster/encode не занимает ≥30% p95;
- Rust без подтверждённой hot phase.
