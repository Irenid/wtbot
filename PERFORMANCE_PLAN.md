# План производительности wtbot

Обновлено: 2026-08-01.

Статус: критические bottleneck текущего ingest-профиля измерены и исправлены.
WRPL parser ускорен примерно на 70%, exact replay reservation устраняет
искусственное ожидание memory budget, а частые SQLite writes и replay lookup
больше не блокируют main thread. Основной end-to-end limiter сейчас находится
в CDN/network. Exact reservation остаётся opt-in, потому что 15-минутный live
run не доказал RSS plateau.

## Цели и ограничения

1. Разбирать backlog с максимальной устойчивой скоростью без роста HTTP 429.
2. Не блокировать Discord, Fastify и voice tracker синхронной работой.
3. Сохранять retry semantics, WRPL bounds-check, worker limits и SQLite durability.
4. Не включать оптимизацию по умолчанию без live evidence и rollback-switch.

## Production profile

| Параметр | Значение | Статус |
| --- | ---: | --- |
| `WT_WORKER_THREADS` | `5` | подтверждённый баланс bot/web/worker |
| `WT_WORKER_BACKGROUND_RESERVE` | `1` | сохраняет interactive slot |
| `WT_INGEST_CONCURRENCY` | `8` | верхняя граница AIMD |
| `WT_REPLAY_PROCESS_BUDGET_MB` | `384` | hard limit replay buffers |
| `WT_INGEST_PIPELINE_ENABLED` | `true` | staged download -> ready -> parse |
| `WT_INGEST_ADAPTIVE_ENABLED` | `true` | default-on после live A/B |
| `WT_REPLAY_EXACT_RESERVATION_ENABLED` | `false` | opt-in до RSS plateau |
| Replay parts concurrency | `2` | production balance CDN/RSS |

## Выполненные оптимизации

### WRPL parser

- `BitReader` читает scalar values без временного `Buffer` на каждый bit/byte.
- GMSync использует reusable RLE scratch, exact-size XOR patch и packed RLE writes.
- MPI dispatch и trajectory thinning больше не создают лишние allocations.
- Профиль parser разделён на header/results, ECS, events, normalize и gzip.
- Binary bounds-check, decompression limits и delta history сохранены.

Fixture `large-mixed-air`, 11.81 МиБ, 1 worker, 10 warm runs:

| Метрика | До | После | Изменение |
| --- | ---: | ---: | ---: |
| Parse p50 | 1246.4 мс | 375.8 мс | -69.9% |
| Parse p95 | 1321.1 мс | 406.7 мс | -69.2% |

После оптимизации packet decode остаётся крупнейшей parser phase, но live CPU
workers не насыщены, поэтому дальнейший rewrite сейчас не имеет end-to-end
приоритета.

### Replay memory и priority

- Trusted identity `Content-Length` сразу пишется в итоговый body buffer.
- Exact network reservation уменьшена с `2x` до `1x Content-Length`.
- Encoded и unknown-length bodies сохраняют conservative bounded fallback.
- Interactive promotion динамически повышает priority уже общей queued загрузки.
- Replay byte budget освобождается после parse, error и abort.

### SQLite и main thread

CPU profiles последовательно нашли три блокирующие операции:

| Операция | Main CPU до исправления | Решение |
| --- | ---: | --- |
| `recordParseResult()` | 9.402 с за 195 с | worker-side SQLite task |
| `updatePlayerStatBoardPublication()` | 3.823 с за 195 с | worker-side SQLite task |
| повторные `hasItem()` | 1.114 с за 130 с | startup cache известных replay ID |

Cache загружается один раз из covering index до старта `wt-replays`. Cache hit
не обращается к SQLite, а miss по-прежнему подтверждается point-read, поэтому
параллельный backfill остаётся корректным.

Финальный CPU-profile: 2 минуты, 43 commit, один worker-side checkpoint
`3018 мс`. Event-loop window max был `133 мс`; блокирующие функции выше исчезли
из main hot path. Значит длительный checkpoint сам по себе больше не замораживает
Discord/Fastify через совпавший sync write/read.

## Live evidence

Все canary использовали 5 workers, reserve 1, ingest max 8, replay budget
384 МиБ, loopback web и принудительно пустой `WT_BATTLES_CHANNEL`.

### Exact reservation A/B

| Режим | Длительность | Commit | Throughput | HTTP 429 | Budget wait mean | RSS p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AIMD, exact off | 5 мин | 64 | 12.8/мин | 1.34% | 12.8 с | 624.5 МиБ |
| AIMD, exact on | 5 мин | 72 | 14.4/мин | 1.78% | 0.1 мс | 631.0 МиБ |

Exact-on дал +12.5% throughput и убрал искусственное ожидание process budget.
Краткий A/B не показал значимого роста RSS p95, но этого недостаточно для
смены default.

### Extended exact-on

15 минут, 196 commit:

- throughput `13.07 battles/min`;
- backlog `1165 -> 969`;
- HTTP 429 `23 / 1733`, или `1.33%` attempts;
- replay budget wait практически нулевой;
- replay budget high-water около `107 МиБ`;
- parse mean `461 мс`, SQLite transaction mean `167 мс`;
- API p95 около `39 мс`;
- RSS p95 около `758 МиБ`, max около `767 МиБ`;
- warm RSS range около `271 МиБ`, plateau не достигнут;
- graceful shutdown `2.14 с`, port 3000 освобождён.

Вывод: exact-on лучше по admission и throughput, но остаётся default-off до
объяснения RSS и повторного длинного exact-off control run.

### Main-thread regression result

До SQLite fixes event-loop window max p95 был примерно `1.8-2.1 с`.
После parser-result offload p95 снизился до `97 мс`, но оставался один startup
stall. После offload player-board write и replay-ID cache финальный профиль дал
window max `133 мс`, включая интервал с трёхсекундным WAL checkpoint.

## Подтверждённые bottleneck

1. **CDN/network pressure.** AIMD стабильно снижает фактическую concurrency до
   2 при 429. Ready и worker queues почти пусты, CPU не насыщен.
2. **RSS attribution.** Whole-process RSS смешивает worker isolates, replay
   buffers, SQLite mmap/page cache и native allocations. Текущий slope нельзя
   трактовать как leak без разложения по компонентам.
3. **WRPL packet decode.** Это крупнейшая offline CPU phase, но не live limiter.
4. **Discord delivery latency.** Canary намеренно не публиковал сообщения,
   поэтому discovery -> preliminary send -> final edit ещё не измерен live.

Больше не считаются активными bottleneck: worst-case replay budget wait,
`recordParseResult`, player-board publication write, repeated known-replay
point lookup, ready queue и CPU worker queue.

## Следующие работы

### P0 - доказать или опровергнуть RSS plateau

1. Добавить attribution для replay retained bytes, worker RSS/native memory и
   SQLite/page cache.
2. Провести сопоставимый 15-минутный exact-off control run на непустом backlog.
3. Сравнивать не только slope, но и warm range, external/ArrayBuffer, worker
   high-water и RSS после graceful shutdown.
4. Включать exact default-on только при throughput gain >=10%, 429 <2% и
   доказанном plateau либо объяснённом bounded RSS.

### P1 - измерить Discord latency

1. Добавить timestamps discovery -> preliminary send -> commit -> final edit.
2. Запустить короткий canary только в выделенном тестовом канале.
3. Gate: preliminary p95 <5 с, final edit p95 <5 с, zero duplicates после restart.

### P2 - продолжать parser optimization только при CPU pressure

Оптимизировать GMSync/packet decode только если live parse queue p95 превысит
100 мс или CPU workers станут устойчиво насыщены. Rust/napi-rs рассматривать
только при >=15% end-to-end gain либо >=2x ускорении оставшейся hot phase.

## Не делать без новых измерений

- не увеличивать production workers выше 5;
- не включать replay parts concurrency 3;
- не включать exact reservation по умолчанию;
- не снимать interactive reserve;
- не ослаблять retry, bounds-check, output limits или timeout;
- не мигрировать на Postgres и не делать Rust/GPU rewrite без доказанного gate.

## Regression gates

Обязательные offline checks:

1. `npm run build`.
2. `npm test`.
3. `npm run verify:workers`.
4. `npm run verify:workers:dist`.
5. `npm run verify:benchmark-corpus`.
6. Для player-board changes: `npm run verify:player-board`.

Live canary запускается только с пустым `WT_BATTLES_CHANNEL` и loopback web.

| Метрика | Gate |
| --- | ---: |
| Offline correctness | 143/143 tests |
| Throughput при backlog | >=10 battles/min |
| HTTP 429 ratio | <2% attempts |
| Ready/worker queue p95 | <100 мс |
| API p95 после warmup | <75 мс |
| Event-loop window max p95 | <250 мс |
| Watchdog stalls после warmup | 0 событий >500 мс |
| Graceful shutdown | <10 с, zero retained budget |
| Exact default-on | Только после RSS gate |

## Rollback

| Проблема | Действие |
| --- | --- |
| Pipeline regression | `WT_INGEST_PIPELINE_ENABLED=false` |
| AIMD regression | `WT_INGEST_ADAPTIVE_ENABLED=false` |
| RSS growth | `WT_REPLAY_EXACT_RESERVATION_ENABLED=false` |
| Worker pressure | уменьшить `WT_INGEST_CONCURRENCY` |
| CDN pressure | оставить shared limiter, AIMD и `Retry-After` |
| Риск Discord flood | очистить `WT_BATTLES_CHANNEL` |

## Ключевые артефакты 2026-08-01

- `data/benchmarks/performance-p2-parser-optimized-20260801.json`
- `data/benchmarks/performance-p2-replay-preallocated-20260801.json`
- `data/benchmarks/performance-live-audit-exact-off-20260801.*`
- `data/benchmarks/performance-live-audit-exact-on-20260801.*`
- `data/benchmarks/performance-live-audit-exact-on-15m-20260801.*`
- `data/benchmarks/performance-live-audit-parser-db-worker-20260801.*`
- `data/benchmarks/performance-live-audit-final-cpuprof-20260801.*`
- `data/benchmarks/performance-live-cpu-profile-final-20260801/*.cpuprofile`
