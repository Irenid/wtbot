---
name: verify
description: Как собрать, запустить и проверить wtbot вживую
---

# Проверка wtbot

Запуск (Node ≥ 22.5, `.env` должен быть заполнен):

```bash
npm run dev        # фоном; бот + сайт (:3000) + парсеры в одном процессе
```

Готовность: `curl -s --retry 15 --retry-connrefused --retry-delay 1 http://localhost:3000/health` → `{"ok":true}`

Что наблюдать:

- лог запуска: `[bot] Готов! Вошёл как …`, `[parser:*] OK — … сохранено: N, без изменений: M` (дедупликация: при повторном запуске сохранено 0);
- `GET /api/stats` — `bot.online: true`, статусы парсеров, счётчики items;
- `GET /api/items?limit=3` — собранные записи; поле `analysis` заполняется после `npm run analyze` (нужен `ANTHROPIC_API_KEY` в `.env`);
- `GET /` — HTML-дашборд;
- регистрация slash-команд: `npm run deploy:commands` (нужны `CLIENT_ID` и `GUILD_ID` в `.env`) → «Зарегистрировано команд: N — на сервере … (мгновенно)». Сами команды в Discord нажать из сессии нельзя — только живым пользователем.

Гочи (Windows):

- остановка dev-сервера: TaskStop фоновой оболочки оставляет дочерний node живым — найти PID на порту 3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`) и `taskkill /PID <pid> /T /F`;
- в git-bash `/tmp` указывает на несуществующий `D:\tmp` — временные файлы класть в scratchpad;
- значения в `.env` могут быть в кавычках: dotenv их снимает, самописные скрипты чтения `.env` должны снимать тоже;
- `ExperimentalWarning: SQLite` при старте — норма (node:sqlite в Node 24).
