# План разделения статистики игрока War Thunder

> **Статус реализации.** План выполнен. Основной источник `official-profile`
> читает страницу профиля warthunder.com, а опциональный `statshark` добавляет
> второй независимый account-snapshot по стабильному WT user id, включая
> текущую статистику отдельных машин. Оба источника используют общие identity,
> snapshots, TTL, stale fallback и read-model; API возвращает основной
> `account` и полный список `accountSources`. Истории StatShark сохраняются в
> `raw_json`, но не складываются повторно с текущими итогами. Актуальные правила
> транспорта и нормализации находятся в AGENTS.md.

## Цель

Хранить и показывать отдельно:

1. **Статистику аккаунта из внешних источников** — агрегаты профиля игрока,
   Реализованы два адаптера: основной `official-profile`
(`src/player-stats/providers/official-profile.ts`, публичная страница профиля
warthunder.com, включён по умолчанию — `WT_PLAYER_STATS_ENABLED`) и
опциональный `statshark` (`src/player-stats/providers/statshark.ts`, выключен
по умолчанию — `STATSHARK_PLAYER_STATS_ENABLED`). Новый источник добавляется
без изменения DB/read-модели.
   профиль или другой согласованный источник.
2. **Статистику собранных боёв** — факты, восстановленные из `.wrpl` и уже
   записанные в `battles`, `battle_players`, `battle_kills` и `battle_chat`.

Источники не смешиваются в одной метрике. В интерфейсе и API они возвращаются
рядом с указанием источника, периода и времени получения.

## Текущая точка интеграции

Существующие таблицы боёв остаются источником истины для replay-статистики:

- `battles.duration_sec` — длительность записи/боя;
- `battles.start_time` — время начала;
- `battles.team_won` — победившая команда, `0` означает неизвестный результат;
- `battle_players.user_id`, `nick`, `nick_base`, `team` — участник и его команда;
- `battle_players.vehicle`, `vehicles` — техника и lineup;
- kills, deaths, assists, score, `squad_id`, `auto_squad` — события и состав.

`getPlayerBattleStats()` сохраняется для обратной совместимости. Новая
статистика должна идти через отдельные функции, поскольку текущая функция
возвращает только число локальных боёв и время последнего боя и уже имеет
существующих вызывающих.

## Целевая модель данных

### 1. Идентичность игрока

Добавить таблицу `player_identities`:

```text
id                 INTEGER PRIMARY KEY
wt_user_id         TEXT NULL
canonical_nick     TEXT NOT NULL
platform           TEXT NULL
created_at         INTEGER NOT NULL
updated_at         INTEGER NOT NULL
```

Добавить таблицу алиасов/связей `player_identity_aliases`:

```text
identity_id        INTEGER NOT NULL
source             TEXT NOT NULL
external_id        TEXT NULL
nick               TEXT NOT NULL
nick_base          TEXT NOT NULL
first_seen_at      INTEGER NOT NULL
last_seen_at       INTEGER NOT NULL
match_method       TEXT NOT NULL       -- user_id, exact_nick, manual
match_confidence   TEXT NOT NULL       -- high, medium, low
PRIMARY KEY (identity_id, source, external_id, nick)
```

Правила:

- числовой `wt_user_id` является предпочтительным ключом;
- полный ник и платформенный суффикс (`@psn`, `@live`, `@epic`) сохраняются;
- `nick_base` используется только для поиска, но не для безусловного merge;
- неоднозначное совпадение не связывается автоматически;
- связь с `battle_players.user_id` сохраняется отдельно от отображаемого ника.

### 2. Внешние снимки профиля

Добавить `player_external_snapshots`:

```text
id                 INTEGER PRIMARY KEY
identity_id        INTEGER NOT NULL
source             TEXT NOT NULL       -- official-profile, statshark, ...
source_player_id   TEXT NULL
nick               TEXT NULL
fetched_at         INTEGER NOT NULL
last_checked_at    INTEGER NOT NULL
source_updated_at  INTEGER NULL
status             TEXT NOT NULL       -- ok, private, not_found, rate_limited,
                                      -- schema_error, error
raw_json           TEXT NULL
content_hash       TEXT NULL
parser_version     TEXT NOT NULL
error              TEXT NULL
```

Индексы:

- `(identity_id, source, fetched_at DESC)`;
- `(source, source_player_id, fetched_at DESC)`;
- `(content_hash)` при необходимости дедупликации.

Сохранять сырой ответ обязательно. Если ответ не изменился, допустимо не
создавать второй большой snapshot: неизменившийся ответ переиспользует уже
сохранённую строку и двигает её колонку `last_checked_at` (отдельной таблицы
состояния provider в схеме нет).

### 3. Нормализованные агрегаты внешнего источника

Добавить `player_external_totals` — одна строка на snapshot, тип игры, режим и
категорию:

```text
snapshot_id
game_type
mode
category
battles
victories
defeats
deaths
time_played_sec
respawns
air_kills
ground_kills
naval_kills
```

Добавить `player_external_vehicles` — одна строка на snapshot и машину:

```text
snapshot_id
game_type
mode
vehicle_id
flyouts
victories
defeats
deaths
air_kills
ground_kills
naval_kills
time_played_sec
```

Неизвестные поля сохраняются как `NULL`, а не как `0`. Суммировать строки
техники для получения account total нельзя: источники могут считать режимы,
категории и победы по разным правилам.

### 4. Статистика реплеев

Сначала не менять схему `battles`. Добавить read-функцию или SQL-view
`getPlayerReplayStats()` с такими полями:

```text
battles
wins
losses
unknown_results
win_rate
air_kills
ground_kills
naval_kills
ai_air_kills
ai_ground_kills
assists
deaths
score
team_kills
observed_battle_time_sec
first_battle_at
last_battle_at
vehicles
coverage_battles
```

Правила расчёта:

- `battles` — `COUNT(DISTINCT session_id)`;
- win/loss считаются только при `team_won != 0`;
- `team_won = 0` попадает в `unknown_results`, а не в losses;
- длительность суммируется один раз на уникальный `session_id`;
- игроки с пустым `user_id` не используются для identity-агрегации без
  отдельного правила сопоставления;
- `win_rate = wins / (wins + losses)`, если знаменатель больше нуля.

Для частых запросов статистики по каждому spawn позднее добавить
`battle_player_vehicles`:

```text
session_id
user_id
vehicle_id
spawn_index
is_first_vehicle
kills
deaths
time_in_battle_sec
```

До этого использовать существующие `vehicle` и JSON `vehicles`.

## Контракт provider-а

Создать source-agnostic интерфейс, например в `src/player-stats/types.ts`:

```ts
interface PlayerStatsProvider {
  readonly source: string
  /** Источник адресуется только стабильным WT user id и не умеет искать по нику. */
  readonly requiresWtUserId?: boolean
  resolvePlayer(nick: string): Promise<PlayerReference[]>
  fetchPlayerStats(player: PlayerReference): Promise<RawPlayerStats>
  /** Прерывает незавершённые запросы при shutdown; повторное закрытие безопасно. */
  close?(): void | Promise<void>
}
```

Реализованы два адаптера: основной `official-profile`
(`src/player-stats/providers/official-profile.ts`, публичная страница профиля
warthunder.com, включён по умолчанию — `WT_PLAYER_STATS_ENABLED`) и
опциональный `statshark` (`src/player-stats/providers/statshark.ts`, выключен
по умолчанию — `STATSHARK_PLAYER_STATS_ENABLED`). Новый источник добавляется
без изменения DB/read-модели.

Provider обязан:

- иметь timeout и ограничение размера ответа;
- валидировать структуру до записи в БД;
- возвращать различимые статусы `private`, `not_found`, `rate_limited`,
  `schema_error` и `error`;
- не обращаться к скрытым профилям, cookies или паролям;
- сохранять версию нормализатора;
- не выполнять запрос на каждый web/API вызов.

## Поток получения внешней статистики

1. Найти игроков среди участников клана, voice presence или разобранных боёв.
2. Взять `wt_user_id` из identity (он приходит только из локальных реплеев);
   provider-ы его не восстанавливают по нику — `official-profile` адресуется
   ником и возвращает `wtUserId: null`, а `statshark` объявляет
   `requiresWtUserId = true` и пропускается, пока id неизвестен.
3. Проверить свежий snapshot; TTL по умолчанию — 24 часа.
4. Если snapshot устарел, поставить игрока в фоновую очередь.
5. Получить и проверить ответ provider-а.
6. В одной транзакции сохранить raw snapshot и нормализованные строки.
7. Обновить identity alias и статус последней проверки.
8. При ошибке оставить последний успешный snapshot и вернуть `stale: true`.

Запросы ограничить известными игроками и не запускать массовый обход всех
ников. Для provider-а нужен guard от наложения запусков, backoff и метрики
успеха/ошибок.

## Read-модель/API

Добавить отдельные функции:

```text
getPlayerReplayStats(playerRef, period?)
getLatestPlayerExternalStats(identityId, source?)
getPlayerStatsComparison(identity, period, context, additionalContexts?)
// публичная точка входа — PlayerStatsCoordinator.lookup({ player, from?, to? })
```

`getPlayerStatsComparison()` возвращает два независимых блока:

```json
{
  "account": {
    "source": "official-profile",
    "fetchedAt": 1760000000,
    "stale": false,
    "totals": {},
    "vehicles": []
  },
  "replay": {
    "source": "wrpl",
    "available": true,
    "userId": "12345678",
    "stats": {
      "battles": 0,
      "wins": 0,
      "losses": 0,
      "unknownResults": 0,
      "winRate": null,
      "coverageBattles": 0,
      "vehicles": []
    },
    "vehicleCount": 0,
    "vehiclesTruncated": false
  }
}
```

Нельзя возвращать единое поле `battles`, если непонятно, lifetime это или
количество собранных реплеев. В каждом блоке должны быть `source`, период и
`fetchedAt`/`coverage`.

## План изменений по файлам

На этапе реализации затронуть только следующие области:

1. `src/db/index.ts` — новые таблицы, миграции, индексы и функции чтения/записи.
2. `src/player-stats/types.ts` — типы identity, snapshot и нормализованных метрик.
3. `src/player-stats/providers/official-profile.ts` и
   `src/player-stats/providers/statshark.ts` — внешние provider-ы.
4. `src/player-stats/normalizer.ts` — преобразование сырого ответа в totals и
   vehicle rows.
5. `src/player-stats/service.ts` — TTL, очередь, сохранение snapshot и связь с
   identity.
6. `src/web/routes/` — отдельный endpoint сравнения, если он нужен dashboard.
7. `src/web/routes/pages.ts` или соответствующий клиентский код — отображение
   блоков `account` и `replay` с источником и датой; тот же
   `PlayerStatsComparison` рендерит Discord-табло `src/bot/player-board.ts`
   и команда `src/bot/commands/player-board.ts`.
8. `src/config.ts`, `.env.example`, `AGENTS.md` — только если появятся новые
   переменные provider-а или расписания.

Существующие функции ingest и `getPlayerBattleStats()` не переписывать без
необходимости. Существующий `clan_rating_snapshots` оставить отдельным
источником рейтинга.

## Этапы реализации

### Этап 1 — replay read-модель

- реализовать `getPlayerReplayStats()`;
- добавить корректный расчёт wins/losses/unknown;
- добавить агрегацию техники из текущих полей;
- покрыть smoke-тестом SQLite `:memory:`.

### Этап 2 — identity и snapshots

- добавить таблицы identity и external snapshots;
- сделать миграции, безопасные для существующей БД;
- сохранять raw JSON, hash, статус и время получения;
- проверить повторную загрузку одного игрока.

### Этап 3 — внешний provider

- реализовать resolve по нику и fetch по `wt_user_id`;
- добавить валидацию и нормализатор;
- добавить TTL 24 часа и stale fallback;
- не включать provider в обязательный ingest-путь.

### Этап 4 — API и отображение

- вернуть `account`, `accountSources` и `replay` раздельно;
- показать источник, свежесть и покрытие;
- явно маркировать неполные/неизвестные значения.

### Этап 5 — расширенная техника и история

- при необходимости добавить `battle_player_vehicles`;
- сохранять изменения внешних snapshots;
- показывать дельты между snapshots;
- добавить сравнение account win rate и replay win rate без их объединения.

## Критерии готовности

- Миграция не удаляет и не изменяет существующие строки боёв.
- Старые `/api` и voice-вызовы продолжают работать.
- В ответе явно различаются `account`, `accountSources` и `replay`.
- `team_won = 0` никогда не считается поражением.
- Внешний provider не блокирует ingest и web при недоступности.
- Для каждого внешнего значения известны `source`, `fetched_at` и статус.
- Повторный одинаковый ответ не создаёт неконтролируемый рост нормализованных
  строк.
- Поля, отсутствующие в источнике, остаются `NULL`.
- Проверки: `npm run build`, `npm test` (node:test, см. AGENTS.md) и
  изолированные SQLite/Fastify smoke-тесты `npm run verify:player-stats`,
  `npm run verify:player-stats-provider`, `npm run verify:player-stats-api`.
- Unit-тестов на `src/player-stats/comparison.ts` и `service.ts` пока нет —
  их логика покрыта только smoke-скриптами.

## Риски и решения

- **Нестабильная внешняя схема:** хранить raw JSON и `parser_version`, при
  ошибке оставлять последний успешный snapshot.
- **Изменение ника/платформы:** связывать по `wt_user_id`, а не только по
  `nick_base`.
- **Неполное покрытие реплеями:** показывать период и `coverage_battles`.
- **Разные определения победы и времени:** не смешивать totals разных источников.
- **Ограничения и приватность внешнего API:** опрашивать только публичные
  профили, с TTL и ограничением частоты; provider сделать отключаемым.
