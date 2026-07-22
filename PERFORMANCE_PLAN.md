# План производительности wtbot

Обновлено: 2026-07-22.

Документ сверён с текущим кодом, схемой SQLite, графом зависимостей и локальными
профилями из `data/benchmarks/`. Галочка `[x]` означает, что механизм уже есть в
текущей рабочей копии. Галочка `[ ]` означает, что пункт ещё предстоит реализовать
или подтвердить репрезентативным benchmark.

## Вывод анализа

Первый крупный bottleneck устранён в текущей рабочей копии: `rasterize()` больше
не сканирует все системные шрифты для каждого PNG. Worker один раз находит
небольшой установленный UI-набор, а CJK fallback подключает только если
соответствующие символы есть в конкретном SVG. Если нужного файла в minimal ОС
нет, остаётся безопасный `loadSystemFonts: true` fallback.

На том же replay парный cold-прогон сократил полный bundle с 6,30 до 2,12 с
(-66,3%), а суммарный `Resvg.init` — с 5,51 до 1,36 с (-75,3%). Относительно
ранее зафиксированного `after-temporal-scene.json` bundle уменьшился с 4,18 до
2,12 с. Результат закреплён corpus-серией из трёх боёв: для каждого выполнен
отдельный cold start и 10 warm-прогонов на одном worker. P1.1 файлового кэша,
P1.2 `/api/voice`, P1.3 stats/refresh и P1.4 replay download/ingest I/O
выполнены; следующий этап — P2 worker scheduling, память и throughput.
Оставшийся `Resvg.init` отслеживается отдельно.

Следствия для порядка работ:

1. Сохранять воспроизводимый corpus/p50/p95 как regression baseline.
2. Оптимизировать файловый кэш, синхронные SQLite-запросы web/voice и
   admission control worker-пула.
3. После этого повторно профилировать WRPL parser и геометрию.
4. Rust, бинарный `events_blob` и GPU разрешать только по измеримому порогу.

Сейчас перенос JSON в бинарный формат не приоритетен: gunzip + UTF-8 +
`JSON.parse` по-прежнему занимают около 8 мс. В финальном прогоне фактический
render + PNG занял 425 мс, а `Resvg.init` — 1363 мс; GPU и смену renderer нельзя
начинать до corpus/p95 и проверки оставшегося font init.

## Актуальные измерения

Среда последнего прогона: AMD Ryzen 5 3600X, 12 логических CPU, Windows x64,
Node.js 24.11.0. Replay `06efea670015c595`: 11 частей, 15,1 МБ, 16 игроков,
15 убийств, 39 траекторий.

| Показатель | Исторический baseline | Перед P0.2 | После P0.2 |
| --- | ---: | ---: | ---: |
| Чтение replay | — | 394 мс¹ | 3,2 мс |
| WRPL parse | 2206 мс | 1599 мс | 1555 мс |
| Полный media bundle | 5295 мс | 6301 мс | 2125 мс |
| Одна `heatmap-air` | 739–832 мс | 642 мс² | 389 мс |
| Максимальный event-loop lag | 45 мс | 13,8 мс | 8,4 мс |
| Peak RSS worker при bundle | — | 296 МиБ | 300 МиБ |
| Peak RSS процесса при bundle | — | 296 МиБ | 300 МиБ |

¹ Первый pre-change read попал на холодный файловый кэш и не входит во время
render. ² Значение из предыдущего одиночного профиля, не парный прогон.

Репрезентативная серия `corpus-explicit-fonts.json`, 1 cold + 10 warm на
сценарий, `--workers=1`, прямой worker render без файлового media-кэша:

| Replay | Характеристика | Parse p50/p95 | Bundle p50/p95 | Resvg init p50/p95 | Lag p50/p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| `06f197b0001e41dc` | 2,9 МиБ, ground, 34 траектории | 316/351 мс | 961/1366 мс | 558/794 мс | 12,7/44,6 мс |
| `06f1a10e001e66d2` | 4,8 МиБ, mixed, 37+5 air | 332/374 мс | 1052/1166 мс | 639/708 мс | 9,7/13,5 мс |
| `06efea670015c595` | 15,1 МиБ, mixed, 39+8 air | 1258/1399 мс | 2080/2289 мс | 1427/1537 мс | 9,7/16,1 мс |

Во всех 33 render-прогонах размеры и SHA-256 семи PNG совпали. Warm queue p95
ниже 0,1 мс, input transfer полного bundle — ниже 4,1 мс, result transfer —
ниже 0,6 мс; основное время действительно находится внутри worker execution.
Process RSS в последовательной серии дошёл до 461 МиБ p95 на большом сценарии;
это включает retained/native allocator state предыдущих сценариев и требует
отдельного plateau/recycle-теста, а не трактовки как независимого peak боя.

Разложение 2122 мс внутри worker после P0.2:

| Фаза | Время | Доля |
| --- | ---: | ---: |
| Resvg init | 1363 мс | 64,2% |
| SVG + подготовка scene | 297 мс | 14,0% |
| PNG encode | 251 мс | 11,8% |
| Resvg render | 174 мс | 8,2% |
| gunzip + UTF-8 + JSON | 8 мс | 0,4% |
| Загрузка модуля/выбор шрифтов | < 20 мс | < 1,0% |
| Копирование результата | < 1 мс | < 0,1% |

Corpus подтверждает текущий warm профиль, но сопоставимого legacy-font corpus
до изменения нет, поэтому точный before/after p95 не заявляется. Отдельно пока
не измерены чтение `events_blob` из SQLite, media cache hit и
запись/вытеснение файлового кэша.

Команда воспроизведения:

```bash
npm run benchmark:workers -- data/replays/06efea670015c595 --render
# Corpus, отдельный cold pool и 10 warm-прогонов на сценарий:
npm run benchmark:workers -- data/replays/06f197b0001e41dc \
  data/replays/06f1a10e001e66d2 data/replays/06efea670015c595 \
  --render --warm=10 --workers=1 --json=data/benchmarks/corpus.json
# Для visual/golden проверки:
npm run benchmark:workers -- data/replays/06efea670015c595 --render \
  --artifacts=data/benchmarks/render-artifacts
# Replay I/O: controlled loopback, реальные WRPL payload, c1/c2/c3 + safety checks:
npm run benchmark:replay -- data/replays/06efea670015c595 --runs=5 \
  --json=data/benchmarks/replay-download-pipeline.json
```

## Что уже сделано

### Worker-пул и изоляция main thread

- [x] WRPL, gzip/zstd, SVG -> PNG и тяжёлая геометрия выполняются в
      `worker_threads`.
- [x] Большие входы передаются через transferable `ArrayBuffer` без лишнего
      clone внутри одной задачи.
- [x] Очередь ограничена количеством задач и суммой входных transferable bytes.
- [x] Есть приоритеты `interactive`, `normal`, `background`, резерв для
      интерактивных запросов и защита background ingest от starvation.
- [x] Backlog ingest разбирается несколькими background workers, но не занимает
      все готовые слоты.
- [x] Queue timeout не расходует попытку ingest; execution timeout завершает и
      заменяет зависший worker.
- [x] Worker имеет old-generation limit и планово заменяется после 12 render-задач,
      чтобы ограничивать накопление native memory Resvg.
- [x] Размер пула автоматически рассчитывается по CPU и доступной RAM; ручное
      переопределение через `WT_WORKER_THREADS` сохранено.
- [x] Shutdown останавливает producers до закрытия CPU pool.

### Media, heatmap и кэш

- [x] `render-media-kind` строит только запрошенный материал.
- [x] Cache miss и режим `WT_BATTLE_CACHE_ENABLED=false` не создают весь bundle
      ради одного PNG/TXT.
- [x] Одновременные сборки одной session дедуплицируются; интерактивный join
      повышает приоритет уже активных worker-зависимостей.
- [x] Bundle один раз декодирует `events_blob`, загружает assets и создаёт data URI
      фоновых карт, затем повторно использует их для общих и team-вариантов.
- [x] Введён `PreparedHeatmapScene`: bounds, экранные координаты, непрерывные
      сегменты, Douglas–Peucker, дистанции и стрелки готовятся один раз.
- [x] Убийства индексируются по victim/killer и времени; поиск точек маршрута и
      первого убийства использует бинарный поиск.
- [x] Spawn-кластеры, стоянки и минутные отметки готовятся до team-фильтрации.
- [x] Все семь PNG после этих изменений побайтово совпали с baseline в
      контрольном прогоне.
- [x] Файлы публикуются атомарно, `meta.json` записывается последним как commit
      marker.
- [x] Дисковый кэш ограничен размером и вытесняет целые session bundles по LRU;
      активная сборка защищена от eviction.
- [x] Старые материалы восстанавливаются из нормализованных таблиц и
      `events_blob`, а не требуют сохранённого replay.
- [x] Кэш включён в конфигурации по умолчанию и может быть отключён явно.

### SQLite и наблюдаемость

- [x] SQLite работает в WAL mode.
- [x] Есть индексы для основных выборок items, snapshots, battles, players,
      kills и chat.
- [x] Parser sources защищены от наложения запусков; `saveItems()` пишет пачку в
      транзакции и пропускает неизменившийся `content_hash`.
- [x] Replay cache ограничивает размер ответа, имеет timeout/retry, глобальный
      интервал между стартами CDN-запросов и атомарную запись файлов.
- [x] Benchmark сохраняет JSON с окружением, входным размером, временем parse и
      render, event-loop lag, main/worker memory и фазами rasterization.
- [x] Benchmark сохраняет font-mode/counts и по `--artifacts=<dir>` выгружает
      PNG/TXT для visual/golden diff.
- [x] Source и dist worker smoke проверяют CPU pool и Resvg.
- [x] Resvg использует явный UI/Cyrillic-набор и ленивые CJK fallback-файлы;
      повторный системный scan отключён на поддерживаемой конфигурации.

## P0. Измерения и устранение Resvg font init

Основной кодовый пункт P0.2 и базовый corpus/p50/p95 выполнены. Недостающие
DB/cache и подробные parse-фазы добавляются вместе с соответствующими этапами.

### P0.1. Репрезентативный benchmark

- [x] Зафиксировать corpus минимум из малого, среднего и большого ground/air боя;
      включить длинный бой с большим количеством траекторий и текста.
- [x] Для каждого сценария собирать cold start и не менее 10 warm-прогонов:
      p50/p95, throughput, event-loop lag, peak/steady RSS, heap, external и
      ArrayBuffer memory.
- [x] Разделить worker queue wait, worker startup, input transfer, execution и
      result transfer.
- [ ] Добавить отдельные фазы чтения `events_blob`, cache lookup/read/write,
      atomic rename и eviction scan.
- [ ] Разбить WRPL parse на header/results BLK, packet stream, ECS/GMSync/FM,
      event extraction, transform и gzip.
- [x] Сохранять параметры рендера, число/размер PNG, cache state и число workers,
      чтобы результаты разных конфигураций были сравнимы.

Затрагиваемые места: `src/analysis/worker-replay-check.ts`,
`src/workers/protocol.ts`, `src/workers/entry.ts`, `src/wrpl/battle-media.ts`.

### P0.2. Явный набор шрифтов для Resvg

- [x] В `rasterize()` заменить безусловный `loadSystemFonts: true` на режим с
      явно разрешёнными UI/Cyrillic и игровыми/symbol font files.
- [x] На Windows находить установленный системный UI-шрифт один раз, не копируя
      и не распространяя его; для Linux определить документированный fallback.
- [x] Проверить `loadSystemFonts: false` отдельно для log, scoreboard, ground/air
      и team-вариантов.
- [x] Проверить русский текст, WT-ники, клан-теги, спецсимволы и fallback glyphs.
- [x] Сравнить cold/warm `resvg.init`, bundle p50/p95 и RSS.
- [ ] Если явные `fontFiles` всё ещё парсятся для каждого экземпляра, исследовать
      backend/API с одним process-level font database либо специализированную
      batch-raster задачу. Не менять renderer до подтверждённого выигрыша.

Критерий принятия: отсутствие пропавших glyphs и неприемлемого visual diff,
bundle p50 быстрее минимум на 20% без роста peak RSS. Целевой ориентир для
эксперимента — `resvg.init` bundle ниже 1,5 с.

Первичный результат на одном replay: glyph regression CJK-ника обнаружена
visual-проверкой и исправлена ленивым Yu Gothic fallback; `loadSystemFonts=false`,
`resvg.init=1,36 с`, bundle 2,12 с. Peak RSS изменился с 296 до 300 МиБ (+1,2%,
в пределах шума одиночного прогона). В corpus большой replay дал warm
`resvg.init` p50/p95 1,43/1,54 с и bundle 2,08/2,29 с; одинаковые SHA-256
подтверждают отсутствие алгоритмического drift.

Проверено для P0.2:

- [x] `npm run build`.
- [x] `npm run verify:workers` и `npm run verify:workers:dist`.
- [x] Bundle, одиночная heatmap, scoreboard, русский и CJK-текст; visual review
      не показывает пропавших glyphs.
- [x] Репрезентативный corpus и не менее 10 warm-прогонов на сценарий.

Затрагиваемые функции: `src/workers/entry.ts:rasterize`,
`src/workers/render-fonts.ts:resolveRenderFonts`, загрузчики шрифтов в
`src/wrpl/wt-fonts.ts` и `src/wrpl/battle-assets.ts`.

## P1. Быстрый cache hit, SQLite и web/voice

### P1.1. Уменьшить write amplification файлового кэша

До P1.1 чтение metadata вызывало `touchBattleBundle()` и до десяти `utimes`, а
чтение самого материала обновляло файл ещё раз. Теперь единым LRU timestamp
служит commit marker, а scan лимита коалесцирован консервативной оценкой bytes.

- [ ] Измерить p50/p95 cache hit на SSD и количество filesystem operations.
- [x] Использовать mtime commit marker как last-access всего bundle и обновлять
      его не чаще заданного интервала, например раз в 1–5 минут на session.
- [x] Не трогать каждый PNG/TXT при каждом чтении metadata.
- [x] Коалесцировать проверки лимита и не сканировать каталог после каждой
      публикации, если известный размер заведомо ниже порога.
- [ ] Держать лёгкий in-memory каталог `{session, bytes, lastAccess}` с
      восстановлением/reconciliation при старте и периодически.
- [ ] Добавить hit/miss/corrupt/evicted bytes по `BattleMediaKind`.
- [ ] Версионировать cache metadata по renderer/config/assets, чтобы смена
      шрифта, масштаба или карты давала предсказуемый miss, а не устаревший PNG.
- [ ] По метрикам оценить точечный idle prewarm часто запрашиваемых материалов;
      не строить весь bundle фоном без спроса и свободного memory/CPU budget.

Сохранить текущие гарантии: meta удаляется первым, публикация meta выполняется
последней, активный session bundle не вытесняется.

Затрагиваемые функции: `cachedBattleMeta()`, `cachedBattleMedia()`,
`touchBattleBundle()`, `publishBattleArtifacts()`, `doEnforceCacheCap()` в
`src/wrpl/battle-media.ts`.

### P1.2. Убрать N+1 в `/api/voice`

Сейчас маршрут сначала читает `voice_presence`, затем для каждого игрока
вызывает `getPlayerRating()` и `getPlayerBattleStats()`. Один игрок создаёт ещё
2–3 синхронных SQLite-запроса; fallback `nick LIKE '<nick>@%'` усложняет
использование индекса.

- [x] Добавить типизированный DB API, возвращающий voice rows, две последние
      rating-записи и battle aggregates одним или ограниченным числом запросов.
- [x] Нормализовать базовый WT-ник при записи и индексировать его, сохранив
      исходный display nick; убрать массовый fallback `LIKE` из hot path.
- [x] Для latest/previous rating использовать оконную функцию или ограниченный
      batch по набору активных ников.
- [x] Подготовить и повторно использовать частые statements, учитывая
      повторную инициализацию/закрытие БД в smoke-тестах.
- [x] Сравнить Fastify `inject()` p50/p95 на 0, 10, 50 и 200 voice rows.

Реализованный `getVoiceDashboardRows()` выполняет один prepared SQL: две
последние rating-строки выбираются ограниченными индексными lookup, battle
aggregate строится один раз для активных base nick. Исходные `nick`/`wt_nick`
не изменяются; добавлены и мигрируются `nick_base`/`wt_nick_base` и три индекса.
Кэш statements очищается в `initDb()`/`closeDb()`. Benchmark дополнительно
проверяет миграцию старой схемы с `@psn`/`@live`.

Локальный `npm run benchmark:voice -- --runs=500` (Fastify `inject()`, SQLite
`:memory:`, три боя на игрока):

| Voice rows | Batch p50 / p95 | N+1 p50 / p95 | Изменение p95 |
| ---: | ---: | ---: | ---: |
| 0 | 0,081 / 0,138 мс | 0,047 / 0,090 мс | шум на пустом ответе |
| 10 | 0,165 / 0,225 мс | 0,183 / 0,285 мс | -21,1% |
| 50 | 0,548 / 0,697 мс | 0,674 / 1,001 мс | -30,4% |
| 200 | 1,894 / 2,547 мс | 2,448 / 3,809 мс | -33,1% |

N+1 baseline здесь консервативный: одиночные функции уже используют новые
base-index и prepared statements, но по-прежнему делают два запроса на игрока.

Затрагиваемые функции: `apiRoutes()`, `getPlayerRating()`,
`getPlayerBattleStats()` и схема/индексы в `src/db/index.ts`.

### P1.3. Снизить стоимость `/api/stats` и refresh

- [x] Объединить шесть `COUNT` из `getIngestStats()` условными агрегатами либо
      кэшировать dashboard snapshot на 1–5 секунд.
- [x] Аналогично не пересчитывать command/item aggregates на каждом polling tick,
      если соответствующие таблицы не изменились.
- [x] Ввести single-flight для `refreshVoice()`: параллельные POST должны ждать
      одну сборку snapshot, а не запускать несколько.
- [x] Не выполнять `DELETE` + полную вставку `voice_presence`, если snapshot не
      изменился; затем перейти к diff upsert/delete при доказанной пользе.
- [x] Ограниченно и параллельно загружать только отсутствующих Discord members,
      не сериализуя сетевые fetch внутри двойного цикла.
- [x] Добавить route rate limit для POST refresh. Cooldown ratings не заменяет
      ограничение Discord snapshot и SQLite-записи.

`getIngestStats()` теперь выполняет один prepared statement и сканирует
`battle_ingest` один раз. Command/item/ingest aggregates возвращаются из
versioned-кэша; локальные writers инвалидируют его сразу, а `PRAGMA data_version`
обнаруживает commit другого процесса не позднее чем через секунду. Voice snapshot
делает diff upsert/delete и сохраняет `joined_at` неизменившихся строк. Отсутствующие
Discord members загружаются с concurrency 4, active clan tags выбираются одним SQL,
refresh имеет single-flight, а POST — single-flight плюс глобальный cooldown 5 с.

`benchmark:voice` проверяет cache invalidation, нулевой diff повторного snapshot,
два одновременных POST с одним вызовом dependency и последующий HTTP 429. Живой
Discord REST smoke сознательно не запускался.

Затрагиваемые функции: `getIngestStats()`, `getCommandStats()`, `getItemStats()`,
`snapshot()`, `refresh()` и `syncVoicePresence()`.

### P1.4. Replay download и ingest I/O

`fetchReplayParts()` теперь использует bounded pipeline c production concurrency
2. Исходный порядок частей, timeout, retry, лимит 96 МиБ на часть и глобальная
пауза 150 мс между стартами CDN-запросов сохранены.

- [x] Измерять local cache hit, ожидание fetch slot, TTFB, download time и bytes
      отдельно для каждой части и всего боя.
- [x] Проверить bounded pipeline на 2–3 одновременных ответа с сохранением
      исходного порядка частей и существующего интервала между стартами.
- [x] Ограничить не только число запросов, но и суммарные in-flight/loaded bytes;
      корректно отменять оставшиеся запросы при abort или фатальной ошибке.
- [x] Сравнить cold ingest latency, CDN error/retry rate и peak RSS; не повышать
      concurrency, если выигрыш мал или сервер отвечает хуже.
- [x] Отдельно измерять путь `item discovered → replay cached → worker parsed →
      SQLite committed`, чтобы сеть не смешивалась с CPU parse.

Pipeline резервирует worst-case 96 МиБ на каждый активный ответ и не допускает
сумму loaded + in-flight выше 512 МиБ. Первая фатальная ошибка или внешний abort
отменяет соседние fetch, ожидание глобального slot и retry delay. Одинаковый part
дедуплицируется отдельным file-lock; разные parts одной сессии читаются
параллельно, а `dropReplayCache()`/TTL cleanup получают эксклюзивный session-lock.

`benchmark:replay` раздаёт реальные corpus-файлы через управляемый loopback HTTP,
для каждого cold-run использует новый временный cache, затем проверяет warm hit.
Это воспроизводимое сравнение pipeline и памяти, а не заявление о скорости
конкретного CDN:

| Replay | Parts / bytes | c1 cold p50/p95 | c2 cold p50/p95 | c3 cold p50/p95 | c2 RSS Δ p95 | c3 RSS Δ p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `06f197b0001e41dc` | 3 / 2,9 МиБ | 1068/1078 мс | 952/956 мс | 1116/1121 мс | 9,0 МиБ | 8,6 МиБ |
| `06f1a10e001e66d2` | 4 / 4,8 МиБ | 1695/1699 мс | 1113/1115 мс | 1109/1112 мс | 9,3 МиБ | 11,1 МиБ |
| `06efea670015c595` | 11 / 15,1 МиБ | 5102/5130 мс | 2839/2885 мс | 2358/2368 мс | 19,4 МиБ | 24,7 МиБ |

На среднем replay c3 улучшил p95 относительно c2 лишь на 0,3%, на малом стал
медленнее. На большом выигрыш c3 составил 17,9%, но peak RSS вырос на 27%, а
worst-case in-flight reservation — на 50%. Поэтому production остаётся на c2:
он снимает 11–44% cold p95 относительно последовательной загрузки без лишнего
третьего ответа к CDN.

Safety-сценарии подтвердили исходный порядок, отдельные buffers для двух callers,
ровно один HTTP request при duplicate, один успешный retry после 429, остановку
после byte budget и отмену активных ответов за 224–456 мс при abort/HTTP 500.
Короткий разрешённый live-run дал Discord ready, web startup и два реальных
успешных ingest timing без ingest/network/fatal errors. Каждый успешный ingest
теперь логирует backlog/discovered→cache, replay, worker queue/execution,
SQLite commit и discovered→commit раздельно.

Затрагиваемые функции: `fetchReplayParts()` в `src/wrpl/replay-events.ts`,
`fetchReplayPart()`/`reserveFetchSlot()` в `src/wrpl/replay-cache.ts` и
`loadBattleData()`, `ingestOne()` и `getPendingBattleItems()`.

## P2. Worker scheduling, память и throughput

Текущий лимит queued bytes учитывает входные transferable buffers, но не
размер SVG/PNG, native allocations Resvg и фактический peak RSS задачи.

- [ ] Ввести оценку веса задачи: parse WRPL, обычный PNG, 2× PNG и bundle;
      учитывать ожидаемые pixels, output bytes и peak native memory.
- [ ] Публиковать queue length/wait/execution по приоритету, timeout stage,
      cold worker start, replacement reason и RSS до/после задачи.
- [ ] Сделать admission control по оценённой памяти и текущей свободной RAM с
      hysteresis; не запускать тяжёлые jobs только потому, что слот свободен.
- [ ] Benchmark-ом подобрать 1/2/3/4 workers для одиночной latency и 2/4
      одновременных боёв; отдельно измерить ingest throughput.
- [ ] Проверить порог замены worker после 12 render jobs: время холодного старта
      против memory plateau.
- [ ] Только после P0 проверить 2–3 параллельные raster-задачи одного bundle.
      Учитывать дублирование scene/assets/font state и рост RSS.
- [ ] Если разделение bundle выгодно, передавать компактный prepared payload;
      не клонировать полный `events_blob` и tactical map каждому worker без
      измеренного выигрыша.

Затрагиваемые места: `CpuWorkerPool.run()`, `nextRunnableJob()`, `dispatch()`,
`workerResourcePlan()`, worker protocol и ingest scheduling.

## P3. Оставшаяся геометрия и SVG

Граф кода показывает кандидатов с высокой сложностью: `buildHeatmapSvg()` имеет
четыре линейных поиска внутри циклов, а `routeCrossings()` — вложенные циклы.
Однако весь SVG сейчас занимает около 245 мс, поэтому это не P0.

- [ ] Добавить grid/spatial index для пересечений маршрутов, collision подписей,
      death/camp/spawn markers и подтвердить снижение асимптотики на большом бою.
- [ ] Повторно использовать неизменяемый SVG background между general/team
      вариантами, если visual diff подтверждает идентичность слоёв.
- [ ] Сократить промежуточные массивы и крупные конкатенации SVG только после
      allocation/CPU profile.
- [ ] Перевести массовые координаты в `Float32Array`/offset arrays, если corpus
      показывает существенный выигрыш RSS или transfer size.
- [ ] Сохранить текущие индексы убийств, binary search и prepared scene; не
      возвращать вычисления в team-specific проходы.

Затрагиваемые функции: `prepareHeatmapScene()`, `buildHeatmapSvg()`,
`routeCrossings()` в `src/wrpl/render-heatmap.ts`.

## P4. WRPL parser и возможный Rust core

Parse последнего replay занимает 1,54 с и станет заметнее после ускорения
рендера. Статический граф выделяет `extractReplayEvents()`, `parseFatBlk()`,
`rle0kiDecompress()`, `parseVehicleState()` и packet deserializers, но
сложность кода сама по себе не доказывает CPU bottleneck.

### P4.1. Сначала профиль TypeScript

- [ ] Собрать CPU profile и пофазные тайминги на полном corpus.
- [ ] Оптимизировать только функции, которые дают заметную долю parse p95:
      уменьшать per-bit/per-packet calls, повторные bounds checks, временные
      объекты и копирования buffers.
- [ ] Проверять точное совпадение players, kills, chat, winner, trajectories,
      DB rows и `events_blob` на fixtures.
- [ ] Добавить damaged/truncated WRPL cases до смены реализации parser.

### P4.2. Rust через napi-rs — только по порогу

- [ ] Создать изолированный prototype `native/wt-core`, если один устойчивый
      CPU-кластер занимает не менее 20% parse p95.
- [ ] Делать один крупный вызов Rust на `ArrayBuffer`, а не N-API вызов на
      каждую точку/packet.
- [ ] Возвращать компактный binary/TypedArray payload и выполнять native code
      внутри существующего worker thread.
- [ ] Требовать минимум 15% end-to-end выигрыша parse или двукратного ускорения
      целевой фазы без роста RSS и ухудшения диагностики.
- [ ] Сохранить TypeScript fixtures, fuzz-тесты, panic containment и prebuilt
      Windows/Linux binaries.
- [ ] До переноса согласовать происхождение и AGPL-атрибуцию портированного
      WRPL-кода: смена языка не отменяет лицензию.

Порядок возможного переноса: `BitReader`/packet stream → ECS/GMSync/FM → event
extraction → весь parser. Discord, Fastify, SQLite, scheduler и конфигурацию в
Rust не переносить.

## P5. Версионированный `events_blob`

Этап отложен: на текущем replay decode занимает 8 мс. Возвращаться к нему,
только если большой corpus покажет decode > 10% render p95, значимый GC/RSS либо
слишком большой объём SQLite.

- [ ] Сравнить текущий gzip JSON с zstd JSON, MessagePack и columnar
      TypedArray/offset layout по decode time, blob size и peak RSS.
- [ ] Ввести версию формата и сохранить чтение старого gzip JSON.
- [ ] Хранить координаты в `Float32`, время в `Uint32`, маршруты через offsets,
      только если точности достаточно для существующего рендера.
- [ ] Выполнять ленивую безопасную миграцию без потери исходных данных.
- [ ] Не смешивать долговечный нормализованный blob с восстанавливаемым cache
      prepared scene.

## P6. Опциональный GPU renderer

GPU не начинать, пока P0 не устранит font init и новый профиль не покажет, что
warm raster/render остаётся значимым bottleneck. В текущем профиле render + PNG
занимают около 9,7% bundle.

Порог для prototype: raster/encode не менее 30% p95 либо throughput упирается в
CPU при нескольких одновременных боях.

- [ ] Один постоянный Rust + `wgpu` device/context и одна ограниченная GPU-очередь.
- [ ] Передавать background textures, polylines и markers; текст сначала оставить
      Resvg/CPU или использовать проверенный glyph atlas.
- [ ] Отдельно измерять upload, render, readback и PNG encode.
- [ ] Сохранить CPU Resvg fallback и автоматическое отключение GPU при ошибке.
- [ ] Сравнивать cold start, p50/p95, throughput, VRAM/RAM, стабильность и
      visual diff, а не только время shader pass.

WRPL, ECS, SQLite, JSON и небольшие геометрические выборки на GPU не переносить.

## Метрики и начальные SLO

Цели необходимо подтвердить corpus-ом и затем закрепить как regression gates:

- cache hit одного материала: p95 < 100 мс без рендера;
- cold render одного стандартного материала: p95 < 500 мс;
- cold full bundle после font-оптимизации: p95 < 3 с;
- WRPL parse: сначала зафиксировать p95, затем целиться ниже 1 с;
- event-loop lag main thread под двумя тяжёлыми jobs: p95 < 50 мс;
- отсутствие OOM/неограниченного RSS при длительном ingest;
- timeout, queue overflow и worker replacement должны быть различимы в метриках.

Минимальные метрики:

- queue length, wait и execution по priority/task kind;
- worker startup/replacement/timeout и memory snapshots;
- cache hit/miss/corruption/eviction/bytes по material kind;
- route latency `/api/stats`, `/api/voice`, `/api/voice/refresh`;
- parse/render phase p50/p95 и event-loop lag.

## Проверки каждого этапа

- [ ] Сначала запускать проверку изменённого модуля.
- [ ] `npm run build`.
- [ ] Для worker/WRPL/render: `npm run verify:workers`.
- [ ] После build: `npm run verify:workers:dist`.
- [ ] Повторять весь benchmark corpus при одинаковой конфигурации и сравнивать
      cold/warm p50/p95, throughput и memory.
- [ ] Для алгоритмических изменений требовать прежние SHA-256 PNG; для
      осознанной смены шрифтов — golden/visual diff и проверку glyph coverage.
- [ ] Проверять ground/air, team 0/1, 1×/2×, cache on/off, cache corruption и
      LRU eviction.
- [ ] Проверять один и несколько одновременных боёв, interactive priority во
      время ingest и bounded shutdown.
- [ ] Для web/DB использовать Fastify `inject()` и SQLite fixture/`:memory:`;
      живой Discord, backfill и внешние API ради performance-теста не запускать.

## Порядок реализации

```text
явные шрифты и устранение повторного Resvg font scan ✓
  → benchmark corpus, p50/p95 и недостающие фазы ✓
  → cache write amplification / LRU hot path ✓
  → batch SQLite для voice и TTL dashboard aggregates ✓
  → bounded replay pipeline и ingest phase timing ✓
  → task weights, memory-aware admission и подбор worker count
  → spatial/SVG оптимизации по новому профилю
  → WRPL CPU profile и точечные TypeScript-оптимизации
  → Rust core только по измеренному порогу
  → binary events_blob только по измеренному порогу
  → GPU только по измеренному порогу
```

Не планируются без новых доказательств: полный rewrite приложения, замена SQLite
на Postgres ради скорости, перенос I/O-слоя в Rust и GPU-рендер текста/WRPL.
