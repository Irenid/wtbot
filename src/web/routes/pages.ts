import type { FastifyPluginAsync } from 'fastify'

// Простой дашборд без сборщика и фреймворка: одна страница, которая
// раз в 10 секунд забирает /api/stats и /api/items. Когда захочешь дашборд
// «как у juniper» (логин через Discord, настройки серверов) — сюда встанет
// полноценный фронтенд, а JSON API уже готов.
const dashboardHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wtbot — панель</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, sans-serif; background: #1a1b26; color: #c0caf5; min-height: 100vh; padding: 32px 16px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .sub { color: #565f89; margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { background: #24283b; border: 1px solid #2f3549; border-radius: 12px; padding: 20px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #565f89; margin-bottom: 12px; }
  .big { font-size: 26px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid #2f3549; font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row span:last-child { text-align: right; flex-shrink: 0; }
  .ok { color: #9ece6a; } .fail { color: #f7768e; } .muted { color: #565f89; }
  .small { font-size: 12px; margin-top: 2px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; }
  .dot.on { background: #9ece6a; } .dot.off { background: #f7768e; }
  .full { grid-column: 1 / -1; }
  .head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .btn { background: #2f3549; border: 1px solid #414868; color: #c0caf5; border-radius: 8px;
         padding: 4px 14px; font-size: 12px; cursor: pointer; text-transform: none; letter-spacing: 0; }
  .btn:hover { background: #414868; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .player-form { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; gap: 8px; margin-bottom: 12px; }
  .input, .select { width: 100%; background: #1a1b26; border: 1px solid #414868; color: #c0caf5;
                    border-radius: 8px; padding: 8px 10px; font: inherit; }
  .player-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 12px; }
  .player-section { min-width: 0; }
  .player-section h3 { color: #7aa2f7; font-size: 14px; margin-bottom: 6px; }
  .player-link { color: #7aa2f7; cursor: pointer; }
  .player-link:hover { text-decoration: underline; }
  .notice { padding: 10px 12px; border-radius: 8px; background: #1f2335; margin-top: 10px; }
  @media (max-width: 620px) { .player-form { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>wtbot</h1>
  <div class="sub">Панель управления — обновляется каждые 10 секунд</div>
  <div class="grid">
    <div class="card full" id="player-stats-card">
      <h2>Статистика игрока War Thunder</h2>
      <form id="player-stats-form" class="player-form">
        <input id="player-stats-query" class="input" name="player" maxlength="64"
               autocomplete="off" placeholder="Точный ник или WT user id" required>
        <select id="player-stats-period" class="select" aria-label="Период локальных реплеев">
          <option value="0">Все реплеи</option>
          <option value="7">7 дней</option>
          <option value="30">30 дней</option>
          <option value="90">90 дней</option>
        </select>
        <button id="player-stats-submit" class="btn" type="submit">Получить</button>
      </form>
      <div id="player-stats-status" class="muted small">Игрок должен уже встречаться в реплеях, voice-снимке или рейтингах.</div>
      <div id="player-stats-result"></div>
    </div>
    <div class="card">
      <h2>Бот</h2>
      <div class="big"><span id="bot-dot" class="dot off"></span><span id="bot-tag">загрузка…</span></div>
      <div class="row"><span class="muted">Серверов</span><span id="bot-guilds">—</span></div>
      <div class="row"><span class="muted">Аптайм</span><span id="bot-uptime">—</span></div>
    </div>
    <div class="card">
      <h2>Команды</h2>
      <div class="big" id="cmd-total">—</div>
      <div id="cmd-list"></div>
    </div>
    <div class="card">
      <h2>Собрано данных</h2>
      <div class="big" id="items-total">—</div>
      <div id="items-by-source"></div>
    </div>
    <div class="card">
      <h2>Разбор боёв</h2>
      <div class="big" id="ingest-done">—</div>
      <div id="ingest-detail"></div>
    </div>
    <div class="card full">
      <h2 class="head-row">В голосовых каналах <button id="voice-refresh" class="btn">Обновить</button></h2>
      <div id="voice-list" class="muted">Загрузка…</div>
    </div>
    <div class="card full">
      <h2>Парсеры</h2>
      <div id="parser-list" class="muted">Загрузка…</div>
    </div>
    <div class="card full">
      <h2>Последние записи</h2>
      <div id="item-list" class="muted">Загрузка…</div>
    </div>
  </div>
</div>
<script>
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + 'д ' : '') + (h ? h + 'ч ' : '') + m + 'м';
}
function row(left, right, cls) {
  const div = document.createElement('div');
  div.className = 'row';
  const l = document.createElement('span'); l.className = 'muted'; l.textContent = left;
  const r = document.createElement('span'); if (cls) r.className = cls; r.textContent = right;
  div.append(l, r);
  return div;
}
// Строка игрока в голосовом канале: «WTНик (Имя)» + статистика War Thunder
function voicePlayerRow(p) {
  const div = document.createElement('div');
  div.className = 'row';
  const left = document.createElement('span');
  left.textContent = p.displayName.includes('(') ? p.displayName : p.wtNick;
  left.className = 'player-link';
  left.title = 'Открыть статистику ' + p.wtNick;
  left.addEventListener('click', function () { beginPlayerLookup(p.wtNick); });
  const right = document.createElement('span');
  right.className = 'muted';
  if (p.rating !== null) {
    const delta = p.delta ? ' (' + (p.delta > 0 ? '+' : '') + p.delta + ')' : '';
    const battles = p.battles ? ' · боёв: ' + p.battles : '';
    right.textContent = (p.clanTag ? p.clanTag + ' · ' : '') + 'ПКР ' + p.rating + delta + battles;
  } else {
    right.textContent = p.battles ? 'боёв: ' + p.battles : 'нет данных WT';
  }
  div.append(left, right);
  return div;
}
function voiceChannelBlock(ch) {
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'row';
  const name = document.createElement('span');
  name.textContent = '🔊 ' + ch.channelName;
  const guild = document.createElement('span');
  guild.className = 'muted';
  guild.textContent = ch.guildName + ' · ' + ch.players.length + ' чел.';
  head.append(name, guild);
  wrap.appendChild(head);
  ch.players.forEach(function (p) { wrap.appendChild(voicePlayerRow(p)); });
  return wrap;
}
function itemRow(it) {
  const div = document.createElement('div');
  div.className = 'row';
  const left = document.createElement('span');
  left.textContent = it.title;
  if (it.analysis) {
    const a = document.createElement('div');
    a.className = 'muted small';
    a.textContent = '🧠 ' + it.analysis;
    left.appendChild(a);
  }
  const right = document.createElement('span');
  right.className = 'muted';
  right.textContent = it.source + ' · ' + new Date(it.updatedAt * 1000).toLocaleTimeString();
  div.append(left, right);
  return div;
}
function fmtTimestamp(value) {
  return value === null ? '—' : new Date(value * 1000).toLocaleString('ru');
}
function fmtPercent(value) {
  return value === null ? '—' : (value * 100).toFixed(1) + '%';
}
function fmtMetric(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('ru');
}
function fmtDelta(value) {
  if (value === null || value === undefined) return '';
  return ' (Δ ' + (value > 0 ? '+' : '') + value.toLocaleString('ru') + ')';
}
function playerSection(title, rows) {
  const section = document.createElement('section');
  section.className = 'player-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);
  rows.forEach(function (entry) { section.appendChild(entry); });
  return section;
}
function accountStateLabel(state) {
  const labels = {
    fresh: 'свежий кэш', stale: 'устаревший кэш', pending: 'загрузка', empty: 'нет снимка',
    disabled: 'отключено', disabled_cached: 'отключено, показан кэш', private: 'профиль закрыт',
    not_found: 'не найден', rate_limited: 'лимит provider-а', schema_error: 'изменилась схема', error: 'ошибка'
  };
  return labels[state] || state;
}
function accountVehicleText(vehicle, delta) {
  const dimensions = [vehicle.gameType, vehicle.mode].filter(Boolean).join(' / ');
  const kills = [vehicle.airKills, vehicle.groundKills, vehicle.navalKills]
    .filter(function (value) { return value !== null; })
    .reduce(function (sum, value) { return sum + value; }, 0);
  const hasKills = vehicle.airKills !== null || vehicle.groundKills !== null || vehicle.navalKills !== null;
  return (dimensions ? dimensions + ' · ' : '')
    + 'вылеты ' + fmtMetric(vehicle.flyouts) + fmtDelta(delta && delta.flyouts)
    + ' · победы ' + fmtMetric(vehicle.victories) + fmtDelta(delta && delta.victories)
    + ' · уничтожено ' + (hasKills ? fmtMetric(kills) : '—');
}
function renderPlayerStats(stats) {
  const root = document.getElementById('player-stats-result');
  const title = document.createElement('div');
  title.className = 'big';
  title.textContent = stats.player.nick + (stats.player.wtUserId ? ' · ID ' + stats.player.wtUserId : '');

  const columns = document.createElement('div');
  columns.className = 'player-columns';

  const accountRows = [
    row('состояние', accountStateLabel(stats.account.state), stats.account.state === 'fresh' ? 'ok' : 'muted'),
    row('источник', stats.account.source),
    row('проверено', fmtTimestamp(stats.account.checkedAt)),
    row('обновлено источником', fmtTimestamp(stats.account.sourceUpdatedAt)),
    row('строк итогов', String(stats.account.totalCount)),
    row('строк техники', String(stats.account.vehicleCount))
  ];
  const deltaByVehicle = new Map();
  const deltaByTotal = new Map();
  if (stats.account.delta) {
    stats.account.delta.totals.forEach(function (total) {
      deltaByTotal.set(JSON.stringify([total.gameType, total.mode, total.category]), total);
    });
    stats.account.delta.vehicles.forEach(function (vehicle) {
      deltaByVehicle.set(JSON.stringify([vehicle.gameType, vehicle.mode, vehicle.vehicleId]), vehicle);
    });
    accountRows.push(row('дельта с', fmtTimestamp(stats.account.delta.fromCheckedAt)));
  }
  stats.account.totals.slice(0, 10).forEach(function (total) {
    const key = JSON.stringify([total.gameType, total.mode, total.category]);
    const delta = deltaByTotal.get(key);
    const label = [total.gameType, total.mode, total.category].filter(Boolean).join(' / ') || 'аккаунт';
    accountRows.push(row(
      label,
      'бои ' + fmtMetric(total.battles) + fmtDelta(delta && delta.battles)
        + ' · победы ' + fmtMetric(total.victories) + fmtDelta(delta && delta.victories)
        + ' · поражения ' + fmtMetric(total.defeats) + fmtDelta(delta && delta.defeats)
    ));
  });
  if (stats.account.totalsTruncated) accountRows.push(row('итоги', 'показаны первые 100 строк'));
  stats.account.vehicles.slice(0, 15).forEach(function (vehicle) {
    const key = JSON.stringify([vehicle.gameType, vehicle.mode, vehicle.vehicleId]);
    accountRows.push(row(vehicle.vehicleId, accountVehicleText(vehicle, deltaByVehicle.get(key))));
  });
  if (stats.account.vehiclesTruncated) accountRows.push(row('техника', 'показаны первые 100 строк'));

  const replayRows = [];
  if (stats.replay.stats) {
    const replay = stats.replay.stats;
    replayRows.push(
      row('бои', fmtMetric(replay.battles)),
      row('победы / поражения', fmtMetric(replay.wins) + ' / ' + fmtMetric(replay.losses)),
      row('без результата', fmtMetric(replay.unknownResults)),
      row('винрейт известных исходов', fmtPercent(replay.winRate)),
      row('фраги воздух / земля / флот', fmtMetric(replay.airKills) + ' / ' + fmtMetric(replay.groundKills) + ' / ' + fmtMetric(replay.navalKills)),
      row('ассисты / смерти', fmtMetric(replay.assists) + ' / ' + fmtMetric(replay.deaths)),
      row('ИИ воздух / земля', fmtMetric(replay.aiAirKills) + ' / ' + fmtMetric(replay.aiGroundKills)),
      row('очки / тимкиллы', fmtMetric(replay.score) + ' / ' + fmtMetric(replay.teamKills)),
      row('наблюдаемое время', fmtUptime(replay.observedBattleTimeSec)),
      row('покрытие', fmtMetric(replay.coverageBattles) + ' локальных реплеев'),
      row('первый / последний', fmtTimestamp(replay.firstBattleAt) + ' / ' + fmtTimestamp(replay.lastBattleAt))
    );
    replay.vehicles.slice(0, 15).forEach(function (vehicle) {
      replayRows.push(row(vehicle.vehicleId, fmtMetric(vehicle.battles) + ' боёв'));
    });
    if (stats.replay.vehiclesTruncated) replayRows.push(row('техника', 'показаны первые 100 строк'));
  } else {
    replayRows.push(row('состояние', 'WT user id ещё не определён'));
  }

  const compareRows = [
    row('account winrate', fmtPercent(stats.comparison.accountWinRate)),
    row('WRPL winrate', fmtPercent(stats.comparison.replayWinRate)),
    row('ориентировочная разница', stats.comparison.indicativeWinRateDifference === null
      ? '—'
      : (stats.comparison.indicativeWinRateDifference * 100).toFixed(1) + ' п.п.'),
    row('совпавшая техника', fmtMetric(stats.comparison.vehicleOverlapCount))
  ];

  columns.append(
    playerSection('Account snapshot', accountRows),
    playerSection('Локальные WRPL', replayRows),
    playerSection('Сопоставление', compareRows)
  );
  const note = document.createElement('div');
  note.className = 'notice muted small';
  note.textContent = stats.comparison.note;
  root.replaceChildren(title, columns, note);
  if (stats.account.error) {
    const error = document.createElement('div');
    error.className = 'notice fail small';
    error.textContent = stats.account.error;
    root.appendChild(error);
  }
}

let playerLookupToken = 0;
async function loadPlayerStats(input, token, attempt) {
  if (token !== playerLookupToken) return;
  const status = document.getElementById('player-stats-status');
  const result = document.getElementById('player-stats-result');
  try {
    const response = await fetch('/api/player-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    });
    const payload = await response.json();
    if (token !== playerLookupToken) return;
    if (!response.ok) {
      status.className = 'fail small';
      status.textContent = payload.error || 'Не удалось получить статистику';
      result.replaceChildren();
      if (Array.isArray(payload.candidates)) {
        payload.candidates.forEach(function (candidate) {
          result.appendChild(row(candidate.nick, candidate.wtUserId || 'без WT user id'));
        });
      }
      return;
    }
    renderPlayerStats(payload.stats);
    if (payload.stats.account.refreshQueued && attempt < 9) {
      status.className = 'muted small';
      status.textContent = 'Локальные WRPL готовы; внешний snapshot обновляется…';
      window.setTimeout(function () { loadPlayerStats(input, token, attempt + 1); }, 2500);
    } else if (payload.stats.account.refreshQueued) {
      status.className = 'muted small';
      status.textContent = 'Внешнее обновление ещё выполняется; повторите поиск через несколько секунд.';
    } else if (['private', 'not_found', 'rate_limited', 'schema_error', 'error'].includes(payload.stats.account.state)) {
      status.className = 'fail small';
      status.textContent = 'Локальные WRPL получены, внешний snapshot недоступен: '
        + accountStateLabel(payload.stats.account.state) + '.';
    } else {
      status.className = 'ok small';
      status.textContent = 'Статистика получена. Account и replay coverage показаны раздельно.';
    }
  } catch (error) {
    if (token !== playerLookupToken) return;
    status.className = 'fail small';
    status.textContent = 'Ошибка запроса статистики: ' + String(error);
  }
}
async function beginPlayerLookup(player) {
  const query = document.getElementById('player-stats-query');
  const period = document.getElementById('player-stats-period');
  const button = document.getElementById('player-stats-submit');
  const status = document.getElementById('player-stats-status');
  if (player !== undefined) query.value = player;
  const normalized = query.value.trim();
  if (!normalized) return;
  const input = { player: normalized };
  const days = Number(period.value);
  if (days > 0) {
    input.to = Math.floor(Date.now() / 1000);
    input.from = input.to - days * 86400;
  }
  const token = ++playerLookupToken;
  status.className = 'muted small';
  status.textContent = 'Читаю локальную статистику…';
  button.disabled = true;
  await loadPlayerStats(input, token, 0);
  if (token === playerLookupToken) button.disabled = false;
}

async function refresh() {
  try {
    const responses = await Promise.all([fetch('/api/stats'), fetch('/api/items?limit=8'), fetch('/api/voice')]);
    const data = await responses[0].json();
    const itemsData = await responses[1].json();
    const voiceData = await responses[2].json();

    document.getElementById('bot-dot').className = 'dot ' + (data.bot.online ? 'on' : 'off');
    document.getElementById('bot-tag').textContent = data.bot.tag || 'offline';
    document.getElementById('bot-guilds').textContent = data.bot.guilds;
    document.getElementById('bot-uptime').textContent = fmtUptime(data.bot.uptimeSec);

    document.getElementById('cmd-total').textContent = data.commands.total;
    const cmdList = document.getElementById('cmd-list');
    cmdList.replaceChildren.apply(cmdList, data.commands.byCommand.slice(0, 5).map(function (c) {
      return row('/' + c.command, String(c.count));
    }));

    document.getElementById('items-total').textContent = data.items.total;
    const bySource = document.getElementById('items-by-source');
    bySource.replaceChildren.apply(bySource, data.items.bySource.slice(0, 5).map(function (s) {
      return row(s.source, String(s.count));
    }));

    if (data.ingest) {
      document.getElementById('ingest-done').textContent = data.ingest.ingested;
      const det = document.getElementById('ingest-detail');
      det.replaceChildren(
        row('в очереди', String(data.ingest.pending), data.ingest.pending ? '' : 'ok'),
        row('не удалось', String(data.ingest.failed), data.ingest.failed ? 'fail' : 'muted'),
        row('игроков', data.ingest.players.toLocaleString('ru')),
        row('убийств', data.ingest.kills.toLocaleString('ru'))
      );
    }

    const voiceList = document.getElementById('voice-list');
    if (voiceData.channels.length === 0) {
      voiceList.classList.add('muted');
      voiceList.textContent = 'В отслеживаемых голосовых каналах никого нет';
    } else {
      voiceList.classList.remove('muted');
      voiceList.replaceChildren.apply(voiceList, voiceData.channels.map(voiceChannelBlock));
    }

    const parserList = document.getElementById('parser-list');
    if (data.parsers.length === 0) {
      parserList.textContent = 'Парсеры ещё не запускались';
    } else {
      parserList.classList.remove('muted');
      parserList.replaceChildren.apply(parserList, data.parsers.map(function (p) {
        const text = (p.summary || p.error || '?') + ' · ' + new Date(p.parsedAt * 1000).toLocaleTimeString();
        return row(p.source, text, p.ok ? 'ok' : 'fail');
      }));
    }

    const itemList = document.getElementById('item-list');
    if (itemsData.items.length === 0) {
      itemList.textContent = 'Записей пока нет — парсеры ещё не принесли данные';
    } else {
      itemList.classList.remove('muted');
      itemList.replaceChildren.apply(itemList, itemsData.items.map(itemRow));
    }
  } catch (e) { console.error(e); }
}
refresh();
setInterval(refresh, 10000);

document.getElementById('player-stats-form').addEventListener('submit', function (event) {
  event.preventDefault();
  beginPlayerLookup();
});

// Принудительное обновление: сервер пересканирует каналы и заново
// запрашивает клановые рейтинги, затем страница перечитывает данные
document.getElementById('voice-refresh').addEventListener('click', async function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Обновляю…';
  try {
    await fetch('/api/voice/refresh', { method: 'POST' });
    await refresh();
  } catch (e) { console.error(e); }
  btn.disabled = false;
  btn.textContent = 'Обновить';
});
</script>
</body>
</html>`

export const pageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(dashboardHtml)
  })
}
