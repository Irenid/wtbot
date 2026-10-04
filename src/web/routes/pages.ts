import type { FastifyPluginAsync } from 'fastify'

// Дашборд без сборщика и фреймворка: одна страница на vanilla JS. Компактный
// /api/dashboard обновляется раз в 15 секунд, тяжёлые site-агрегаты — раз в
// минуту, а скрытая вкладка polling не выполняет. Статистика игрока строится
// из POST /api/player-stats. Пользовательские данные вставляются только через
// DOM textContent.
//
// Цвета серий графиков (воздух/земля/флот) проверены валидатором палитры на
// тёмной поверхности карточек: контраст >= 3:1, разделимость при дальтонизме.
const dashboardHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wtbot — панель</title>
<style>
  /* One theme with the site: warm black and a gold accent. */
  :root {
    color-scheme: dark;
    --bg: #111015; --card: #1e1c23; --inset: #18161b;
    --line: #2d2b33; --line2: #4a4655;
    --ink: #f2efe6; --ink2: #b8b3ac; --muted: #918c99;
    --ok: #8ee6a1; --fail: #ff8fa3; --accent: #f5bc4a;
    --air: #5f80f2; --ground: #d0731f; --naval: #1fae86;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(900px 420px at 50% -80px, rgba(245, 188, 74, 0.14), transparent 62%), var(--bg);
    color: var(--ink); min-height: 100vh; padding: 32px 16px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: #f0d9a0; }
  h1 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 24px; margin-bottom: 4px; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card {
    background: linear-gradient(180deg, #211f27, #18171d);
    border: 1px solid #37343f; border-radius: 16px; padding: 20px;
    box-shadow: 0 24px 50px -34px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .card h2 { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink2); font-weight: 600; margin-bottom: 12px; }
  .big { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  .row:last-child { border-bottom: none; }
  .row span:last-child { text-align: right; flex-shrink: 0; }
  .ok { color: var(--ok); } .fail { color: var(--fail); } .muted { color: var(--muted); }
  .small { font-size: 12px; margin-top: 2px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; }
  .dot.on { background: var(--ok); } .dot.off { background: var(--fail); }
  .full { grid-column: 1 / -1; }
  .head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .btn { background: var(--inset); border: 1px solid var(--line2); color: var(--ink); border-radius: 8px;
         padding: 4px 14px; font-size: 12px; cursor: pointer; text-transform: none; letter-spacing: 0; }
  .btn:hover { background: var(--card); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn[type="submit"] {
    background: linear-gradient(135deg, #ffdf8a, #f0a72e); border: none; color: #231a06; font-weight: 700;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 16px 32px -16px rgba(245, 188, 74, 0.55);
  }
  .btn[type="submit"]:hover { filter: brightness(1.1); background: linear-gradient(135deg, #ffdf8a, #f0a72e); }
  .player-form { display: grid; grid-template-columns: minmax(180px, 1fr) auto auto; gap: 8px; margin-bottom: 12px; }
  .input, .select { width: 100%; background: var(--bg); border: 1px solid var(--line2); color: var(--ink);
                    border-radius: 8px; padding: 8px 10px; font: inherit; }
  .player-link { color: var(--accent); cursor: pointer; }
  .player-link:hover { text-decoration: underline; }
  .notice { padding: 10px 12px; border-radius: 8px; background: var(--inset); margin-top: 10px; }

  /* Статистика игрока */
  .player-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin: 14px 0 4px; }
  .player-name { font-size: 24px; font-weight: 600; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px;
          border: 1px solid var(--line2); color: var(--ink2); white-space: nowrap; }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.fail { color: var(--fail); border-color: var(--fail); }
  .panel { background: var(--inset); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-top: 12px; }
  .panel-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 10px; }
  .panel-head h3 { color: var(--accent); font-size: 14px; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
  .kpi { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .kpi .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .kpi .v { font-size: 21px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .kpi .s { font-size: 11px; color: var(--ink2); margin-top: 2px; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 88px; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }
  .bar-label { color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-track { height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: var(--air); }
  .stack { display: flex; height: 14px; border-radius: 4px; overflow: hidden; gap: 2px; margin: 6px 0 8px; }
  .seg { height: 100%; border-radius: 2px; min-width: 3px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--ink2); }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .tbl-scroll { overflow-x: auto; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
            letter-spacing: 0.05em; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .tbl td { padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
  .tbl .bar-cell { min-width: 110px; }
  .delta { color: var(--ink2); font-size: 11px; margin-left: 4px; }
  .src-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
  .src-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .src-card .row { font-size: 13px; padding: 4px 0; }
  .src-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
  .src-name { font-weight: 600; font-size: 13px; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .metric-box { background: var(--inset); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  .metric-box .label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .metric-box .value { font-size: 22px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .metric-box .hint { color: var(--ink2); font-size: 11px; margin-top: 2px; }
  .progress { height: 7px; background: var(--bg); border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .progress > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
  .split-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .section-title { color: var(--accent); font-size: 13px; font-weight: 600; margin: 14px 0 7px; }
  .section-title:first-child { margin-top: 0; }
  .activity { display: flex; align-items: end; gap: 7px; min-height: 92px; padding-top: 12px; }
  .activity-col { flex: 1; min-width: 0; text-align: center; color: var(--muted); font-size: 10px; }
  .activity-bar { min-height: 2px; background: linear-gradient(180deg, #ffd979, #d89322); border-radius: 5px 5px 2px 2px; margin-bottom: 5px; }
  .status-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .status-line .small { margin: 0; }
  @media (max-width: 620px) {
    .player-form { grid-template-columns: 1fr; }
    .bar-row { grid-template-columns: 90px 1fr 78px; }
    .split-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>wt<span>bot</span></h1>
  <div class="sub">Полная телеметрия проекта · адаптивное обновление без тяжёлого polling · <a href="/">сайт →</a></div>
  <div class="grid">
    <div class="card full">
      <div class="status-line">
        <div>
          <h2>Состояние системы</h2>
          <div class="big"><span id="bot-dot" class="dot off"></span><span id="bot-tag">загрузка…</span></div>
        </div>
        <div id="dashboard-freshness" class="muted small">Первый снимок…</div>
      </div>
      <div id="overview-metrics" class="metric-grid" style="margin-top:14px"></div>
    </div>
    <div class="card full">
      <h2>Процесс и ресурсы</h2>
      <div id="runtime-metrics" class="metric-grid"></div>
      <div class="split-grid">
        <div>
          <div class="section-title">CPU worker pool</div>
          <div id="worker-detail"></div>
        </div>
        <div>
          <div class="section-title">WRPL ingest</div>
          <div id="ingest-detail"></div>
        </div>
      </div>
      <div class="section-title">Нагрузки worker pool</div>
      <div id="worker-workloads" class="muted small">Загрузка…</div>
      <div class="section-title">Очереди статистики игроков</div>
      <div id="player-stats-services" class="muted small">Загрузка…</div>
    </div>
    <div class="card">
      <h2>Команды Discord</h2>
      <div class="big" id="cmd-total">—</div>
      <div id="cmd-list"></div>
    </div>
    <div class="card">
      <h2>Источники данных</h2>
      <div class="big" id="items-total">—</div>
      <div id="items-by-source"></div>
    </div>
    <div class="card">
      <h2>WT transport</h2>
      <div class="big" id="transport-mode">—</div>
      <div id="transport-detail"></div>
    </div>
    <div class="card">
      <h2>Данные сайта</h2>
      <div class="big" id="site-battles">—</div>
      <div id="site-detail"></div>
    </div>
    <div class="card full">
      <h2>Активность боёв за 7 дней</h2>
      <div id="site-activity" class="activity muted">Загрузка…</div>
    </div>
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
    <div class="card full">
      <h2 class="head-row">В голосовых каналах <button id="voice-refresh" class="btn">Обновить</button></h2>
      <div id="season-status" class="muted small">Сезон: загрузка…</div>
      <div id="voice-list" class="muted">Загрузка…</div>
    </div>
    <div class="card full">
      <h2>Парсеры</h2>
      <div id="parser-list" class="muted">Загрузка…</div>
    </div>
    <div class="card full">
      <h2>Последние записи источников</h2>
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
    right.textContent = (p.clanTag ? p.clanTag + ' · ' : '') + 'ЛПР ' + p.rating + delta + battles;
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
  if (it.analysis || it.analyzed) {
    const a = document.createElement('div');
    a.className = 'muted small';
    a.textContent = it.analysis ? 'AI: ' + it.analysis : 'AI-анализ сохранён';
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
  return value === null || value === undefined ? '—' : (value * 100).toFixed(1) + '%';
}
function fmtMetric(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('ru');
}
function fmtBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const bytes = Math.max(0, Number(value));
  if (bytes < 1024) return Math.round(bytes) + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КиБ';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МиБ';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' ГиБ';
}
function fmtMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const ms = Math.max(0, Number(value));
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' с' : ms.toFixed(ms < 10 ? 1 : 0) + ' мс';
}
function fmtHours(value) {
  return value === null || value === undefined ? '—' : Math.round(value / 3600).toLocaleString('ru') + ' ч';
}
function accountStateLabel(state) {
  const labels = {
    fresh: 'свежий кэш', stale: 'устаревший кэш', pending: 'загрузка', empty: 'нет снимка',
    disabled: 'отключено', disabled_cached: 'отключено, показан кэш', private: 'профиль закрыт',
    not_found: 'не найден', rate_limited: 'лимит provider-а', schema_error: 'изменилась схема', error: 'ошибка'
  };
  return labels[state] || state;
}
function stateChipClass(state) {
  if (state === 'fresh') return 'ok';
  if (state === 'private' || state === 'not_found' || state === 'rate_limited'
    || state === 'schema_error' || state === 'error') return 'fail';
  return '';
}

// --- Примитивы построения DOM (только textContent, без разметки строками) ---
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function chipEl(text, cls) {
  return el('span', 'chip' + (cls ? ' ' + cls : ''), text);
}
function deltaChip(value, suffix) {
  if (value === null || value === undefined || value === 0) return null;
  const text = (value > 0 ? '+' : '') + value.toLocaleString('ru') + (suffix || '');
  return el('span', 'delta', text);
}
function kpiTile(label, value, sub) {
  const tile = el('div', 'kpi');
  tile.appendChild(el('div', 'l', label));
  tile.appendChild(el('div', 'v', value));
  if (sub) tile.appendChild(el('div', 's', sub));
  return tile;
}
function metricBox(label, value, hint, fraction, color) {
  const box = el('div', 'metric-box');
  box.appendChild(el('div', 'label', label));
  box.appendChild(el('div', 'value', value));
  if (hint) box.appendChild(el('div', 'hint', hint));
  if (fraction !== undefined && fraction !== null) {
    const progress = el('div', 'progress');
    const fill = el('span');
    fill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
    if (color) fill.style.background = color;
    progress.appendChild(fill);
    box.appendChild(progress);
  }
  return box;
}
function barTrack(fraction, color, title) {
  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  if (color) fill.style.background = color;
  const pct = fraction === null || fraction === undefined
    ? 0
    : Math.max(0, Math.min(1, fraction)) * 100;
  fill.style.width = pct + '%';
  if (title) track.title = title;
  track.appendChild(fill);
  return track;
}
function barRow(label, fraction, rightText, color) {
  const wrap = el('div', 'bar-row');
  wrap.appendChild(el('span', 'bar-label', label));
  wrap.appendChild(barTrack(fraction, color, label + ': ' + rightText));
  wrap.appendChild(el('span', 'bar-value', rightText));
  return wrap;
}
function panel(title, sub) {
  const sec = el('section', 'panel');
  const head = el('div', 'panel-head');
  head.appendChild(el('h3', null, title));
  if (sub) head.appendChild(el('span', 'muted small', sub));
  sec.appendChild(head);
  return sec;
}
function tableEl(headers) {
  const scroll = el('div', 'tbl-scroll');
  const table = el('table', 'tbl');
  const thead = el('thead');
  const headRow = el('tr');
  headers.forEach(function (h) {
    const th = el('th', h.num ? 'num' : null, h.label);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  scroll.appendChild(table);
  return { root: scroll, tbody: tbody };
}
function numCell(value, delta) {
  const td = el('td', 'num', fmtMetric(value));
  const chip = deltaChip(delta);
  if (chip) td.appendChild(chip);
  return td;
}

// --- Извлечение данных из нормализованных totals/vehicles ---
const MODE_LABELS = { arcade: 'Аркадные', realistic: 'Реалистичные', simulation: 'Симуляторные', simulator: 'Симуляторные' };
const KILL_PARTS = [
  { key: 'airKills', label: 'воздух', color: 'var(--air)' },
  { key: 'groundKills', label: 'земля', color: 'var(--ground)' },
  { key: 'navalKills', label: 'флот', color: 'var(--naval)' }
];
const BRANCH_META = {
  air: { label: 'Авиация', color: 'var(--air)' },
  ground: { label: 'Наземная техника', color: 'var(--ground)' },
  naval: { label: 'Флот', color: 'var(--naval)' }
};
function aggregateTotal(account) {
  if (!account || !Array.isArray(account.totals)) return null;
  return account.totals.find(function (t) {
    return t.gameType === null && t.mode === null && t.category === null;
  }) || null;
}
// Строки по режимам: у official-profile это (gameType=null, category='all'),
// у StatShark — (gameType='all', category='pvp'); ветки техники не подходят.
function modeTotals(account) {
  const rows = [];
  const seen = {};
  (account && account.totals ? account.totals : []).forEach(function (t) {
    if (t.mode === null) return;
    if (t.gameType !== null && t.gameType !== 'all') return;
    if (t.category !== null && t.category !== 'all' && t.category !== 'pvp') return;
    if (seen[t.mode]) return;
    seen[t.mode] = true;
    rows.push(t);
  });
  return rows;
}
function sumKills(t) {
  if (!t) return null;
  let sum = 0, known = false;
  KILL_PARTS.forEach(function (p) {
    if (t[p.key] !== null && t[p.key] !== undefined) { sum += t[p.key]; known = true; }
  });
  return known ? sum : null;
}
function winRateOf(t) {
  if (!t || !t.battles || t.victories === null || t.victories === undefined) return null;
  return t.victories / t.battles;
}
function kdOf(t) {
  const kills = sumKills(t);
  if (kills === null || !t || !t.deaths) return null;
  return kills / t.deaths;
}

// --- Блоки статистики игрока ---
function playerHeader(stats) {
  const head = el('div', 'player-head');
  head.appendChild(el('span', 'player-name', stats.player.nick));
  if (stats.player.wtUserId) head.appendChild(chipEl('ID ' + stats.player.wtUserId));
  if (stats.player.platform) head.appendChild(chipEl(stats.player.platform));
  if (stats.period && stats.period.from !== null) {
    head.appendChild(chipEl('реплеи с ' + new Date(stats.period.from * 1000).toLocaleDateString('ru')));
  }
  return head;
}
function accountKpis(account, total) {
  const sec = panel('Аккаунт · ' + account.source,
    'снимок источника' + (account.sourceUpdatedAt ? ' от ' + fmtTimestamp(account.sourceUpdatedAt) : ''));
  const kpis = el('div', 'kpis');
  const rate = winRateOf(total);
  kpis.appendChild(kpiTile('Бои', fmtMetric(total.battles)));
  const rateTile = kpiTile('Винрейт', fmtPercent(rate),
    fmtMetric(total.victories) + ' побед · ' + fmtMetric(total.defeats) + ' поражений');
  if (rate !== null) rateTile.appendChild(barTrack(rate, 'var(--air)', 'винрейт ' + fmtPercent(rate)));
  kpis.appendChild(rateTile);
  const kd = kdOf(total);
  kpis.appendChild(kpiTile('Фраги/смерть', kd === null ? '—' : kd.toFixed(2),
    fmtMetric(sumKills(total)) + ' фрагов · ' + fmtMetric(total.deaths) + ' смертей'));
  kpis.appendChild(kpiTile('Время в бою', fmtHours(total.timePlayedSec)));
  sec.appendChild(kpis);
  const kills = killsBlock(total);
  if (kills) sec.appendChild(kills);
  return sec;
}
// Состав фрагов воздух/земля/флот: пропорциональный стек + легенда со значениями
function killsBlock(total) {
  const values = KILL_PARTS.map(function (p) { return total ? total[p.key] : null; });
  const known = values.filter(function (v) { return v !== null && v !== undefined; });
  if (!known.length) return null;
  const sum = known.reduce(function (a, b) { return a + b; }, 0);
  const block = el('div');
  block.style.marginTop = '10px';
  if (sum > 0) {
    const stack = el('div', 'stack');
    KILL_PARTS.forEach(function (p, i) {
      const v = values[i];
      if (v === null || v === undefined || v <= 0) return;
      const seg = el('div', 'seg');
      seg.style.background = p.color;
      seg.style.flexGrow = String(v);
      seg.title = p.label + ': ' + fmtMetric(v) + ' (' + (v / sum * 100).toFixed(1) + '%)';
      stack.appendChild(seg);
    });
    block.appendChild(stack);
  }
  const legend = el('div', 'legend');
  KILL_PARTS.forEach(function (p, i) {
    const item = el('span');
    const sw = el('span', 'swatch');
    sw.style.background = p.color;
    item.appendChild(sw);
    item.appendChild(document.createTextNode(p.label + ' ' + fmtMetric(values[i])));
    legend.appendChild(item);
  });
  block.appendChild(legend);
  return block;
}
function modeTablePanel(account, deltaByTotal) {
  const rows = modeTotals(account);
  if (!rows.length) return null;
  const sec = panel('По режимам', account.source);
  const table = tableEl([
    { label: 'Режим' }, { label: 'Бои', num: true }, { label: 'Победы', num: true },
    { label: 'Смерти', num: true }, { label: 'Время', num: true },
    { label: 'Фраги в/н/ф', num: true }, { label: 'Винрейт' }
  ]);
  rows.forEach(function (t) {
    const tr = el('tr');
    const modeCell = el('td', null, MODE_LABELS[t.mode] || t.mode);
    if (t.category === 'pvp') modeCell.appendChild(el('span', 'delta', 'pvp'));
    tr.appendChild(modeCell);
    const delta = deltaByTotal.get(JSON.stringify([t.gameType, t.mode, t.category]));
    tr.appendChild(numCell(t.battles, delta && delta.battles));
    tr.appendChild(numCell(t.victories, delta && delta.victories));
    tr.appendChild(numCell(t.deaths, delta && delta.deaths));
    tr.appendChild(el('td', 'num', fmtHours(t.timePlayedSec)));
    tr.appendChild(el('td', 'num',
      fmtMetric(t.airKills) + ' / ' + fmtMetric(t.groundKills) + ' / ' + fmtMetric(t.navalKills)));
    const rate = winRateOf(t);
    const rateCell = el('td', 'bar-cell');
    const rateWrap = el('div', 'bar-row');
    rateWrap.style.gridTemplateColumns = '1fr 52px';
    rateWrap.style.padding = '0';
    rateWrap.appendChild(barTrack(rate, 'var(--air)', 'винрейт ' + fmtPercent(rate)));
    rateWrap.appendChild(el('span', 'bar-value small', fmtPercent(rate)));
    rateCell.appendChild(rateWrap);
    tr.appendChild(rateCell);
    table.tbody.appendChild(tr);
  });
  sec.appendChild(table.root);
  return sec;
}
// Выходы на задания по веткам техники (только official-profile). Это спавны,
// НЕ бои: в одном бою игрок может и летать, и ездить — суммировать с боями нельзя.
function branchSpawnsPanel(sources) {
  const perBranch = {};
  sources.forEach(function (account) {
    (account.totals || []).forEach(function (t) {
      const meta = BRANCH_META[t.gameType];
      if (!meta || t.respawns === null || t.respawns === undefined) return;
      if (t.category !== 'all' && t.category !== null) return;
      perBranch[t.gameType] = (perBranch[t.gameType] || 0) + t.respawns;
    });
  });
  const keys = Object.keys(perBranch);
  if (!keys.length) return null;
  const max = keys.reduce(function (m, k) { return Math.max(m, perBranch[k]); }, 0);
  const sec = panel('Выходы на задания по веткам', 'спавны, не бои — не суммируются с боями');
  keys.forEach(function (k) {
    sec.appendChild(barRow(BRANCH_META[k].label, max > 0 ? perBranch[k] / max : 0,
      fmtMetric(perBranch[k]), BRANCH_META[k].color));
  });
  return sec;
}
function sourceCard(account) {
  const card = el('div', 'src-card');
  const head = el('div', 'src-head');
  head.appendChild(el('span', 'src-name', account.source));
  const chips = el('span');
  chips.appendChild(chipEl(accountStateLabel(account.state), stateChipClass(account.state)));
  if (account.refreshQueued) chips.appendChild(document.createTextNode(' '));
  if (account.refreshQueued) chips.appendChild(chipEl('обновляется…'));
  head.appendChild(chips);
  card.appendChild(head);
  const aggregate = aggregateTotal(account) || (account.totals && account.totals[0]) || null;
  card.appendChild(row('Бои / победы', aggregate
    ? fmtMetric(aggregate.battles) + ' / ' + fmtMetric(aggregate.victories)
    : '—'));
  card.appendChild(row('Винрейт', fmtPercent(winRateOf(aggregate))));
  card.appendChild(row('Строк техники', String(account.vehicleCount)));
  card.appendChild(row('Проверено', fmtTimestamp(account.checkedAt)));
  card.appendChild(row('Обновлено источником', fmtTimestamp(account.sourceUpdatedAt)));
  if (account.delta) card.appendChild(row('Дельта с', fmtTimestamp(account.delta.fromCheckedAt)));
  return card;
}
function sourcesPanel(sources) {
  const sec = panel('Источники аккаунта', 'кэш до 24 часов, обновление в фоне');
  const grid = el('div', 'src-grid');
  sources.forEach(function (account) { grid.appendChild(sourceCard(account)); });
  sec.appendChild(grid);
  return sec;
}
function vehiclesPanel(account) {
  const vehicles = account.vehicles.slice(0, 12);
  if (!vehicles.length) return null;
  const deltaByVehicle = new Map();
  if (account.delta) {
    account.delta.vehicles.forEach(function (vehicle) {
      deltaByVehicle.set(JSON.stringify([vehicle.gameType, vehicle.mode, vehicle.vehicleId]), vehicle);
    });
  }
  const sec = panel('Топ техники · ' + account.source,
    'по вылетам' + (account.vehiclesTruncated || account.vehicleCount > vehicles.length
      ? ', показано ' + vehicles.length + ' из ' + account.vehicleCount : ''));
  const table = tableEl([
    { label: 'Техника' }, { label: 'Тип' }, { label: 'Режим' },
    { label: 'Вылеты', num: true }, { label: 'Победы', num: true },
    { label: 'Смерти', num: true }, { label: 'Фраги', num: true }, { label: 'Поб/вылет' }
  ]);
  vehicles.forEach(function (v) {
    const tr = el('tr');
    tr.appendChild(el('td', null, v.vehicleId));
    tr.appendChild(el('td', 'muted', v.gameType || '—'));
    tr.appendChild(el('td', 'muted', MODE_LABELS[v.mode] || v.mode || '—'));
    const delta = deltaByVehicle.get(JSON.stringify([v.gameType, v.mode, v.vehicleId]));
    tr.appendChild(numCell(v.flyouts, delta && delta.flyouts));
    tr.appendChild(numCell(v.victories, delta && delta.victories));
    tr.appendChild(numCell(v.deaths, delta && delta.deaths));
    tr.appendChild(el('td', 'num', fmtMetric(sumKills(v))));
    const rate = v.flyouts && v.victories !== null && v.victories !== undefined
      ? Math.min(1, v.victories / v.flyouts)
      : null;
    const rateCell = el('td', 'bar-cell');
    const rateWrap = el('div', 'bar-row');
    rateWrap.style.gridTemplateColumns = '1fr 52px';
    rateWrap.style.padding = '0';
    rateWrap.appendChild(barTrack(rate, 'var(--air)', 'побед на вылет: ' + fmtPercent(rate)));
    rateWrap.appendChild(el('span', 'bar-value small', fmtPercent(rate)));
    rateCell.appendChild(rateWrap);
    tr.appendChild(rateCell);
    table.tbody.appendChild(tr);
  });
  sec.appendChild(table.root);
  return sec;
}
function replayPanel(replay) {
  const sec = panel('Локальные WRPL-реплеи', 'только бои, собранные ботом');
  if (!replay.stats) {
    sec.appendChild(el('div', 'muted small', 'WT user id ещё не определён — replay-статистика недоступна.'));
    return sec;
  }
  const r = replay.stats;
  const kpis = el('div', 'kpis');
  kpis.appendChild(kpiTile('Бои', fmtMetric(r.battles),
    fmtMetric(r.wins) + ' побед · ' + fmtMetric(r.losses) + ' поражений'));
  const rateTile = kpiTile('Винрейт', fmtPercent(r.winRate), 'без учёта ' + fmtMetric(r.unknownResults) + ' неизвестных исходов');
  if (r.winRate !== null) rateTile.appendChild(barTrack(r.winRate, 'var(--air)', 'винрейт ' + fmtPercent(r.winRate)));
  kpis.appendChild(rateTile);
  const kills = sumKills(r);
  kpis.appendChild(kpiTile('Фраги/смерть', r.deaths ? (kills / r.deaths).toFixed(2) : '—',
    fmtMetric(kills) + ' фрагов · ' + fmtMetric(r.deaths) + ' смертей'));
  kpis.appendChild(kpiTile('Очки', fmtMetric(r.score), 'ассистов ' + fmtMetric(r.assists)));
  sec.appendChild(kpis);
  const killsSplit = killsBlock(r);
  if (killsSplit) sec.appendChild(killsSplit);
  const details = el('div');
  details.style.marginTop = '10px';
  details.appendChild(row('ИИ воздух / земля', fmtMetric(r.aiAirKills) + ' / ' + fmtMetric(r.aiGroundKills)));
  details.appendChild(row('Тимкиллы', fmtMetric(r.teamKills)));
  details.appendChild(row('Наблюдаемое время', fmtUptime(r.observedBattleTimeSec)));
  details.appendChild(row('Покрытие', fmtMetric(r.coverageBattles) + ' локальных реплеев'));
  details.appendChild(row('Первый / последний бой', fmtTimestamp(r.firstBattleAt) + ' / ' + fmtTimestamp(r.lastBattleAt)));
  sec.appendChild(details);
  if (Array.isArray(r.vehicles) && r.vehicles.length) {
    const top = r.vehicles.slice(0, 8);
    const max = top.reduce(function (m, v) { return Math.max(m, v.battles || 0); }, 0);
    const list = el('div');
    list.style.marginTop = '10px';
    list.appendChild(el('div', 'muted small', 'Техника в локальных реплеях'));
    top.forEach(function (v) {
      list.appendChild(barRow(v.vehicleId, max > 0 ? (v.battles || 0) / max : 0,
        fmtMetric(v.battles) + ' боёв', 'var(--ground)'));
    });
    if (replay.vehiclesTruncated || replay.vehicleCount > top.length) {
      list.appendChild(el('div', 'muted small',
        'показано ' + top.length + ' из ' + fmtMetric(replay.vehicleCount)));
    }
    sec.appendChild(list);
  }
  return sec;
}
// accountSource — имя основного источника: comparison.accountWinRate считается
// сервером только по нему, а KPI-блок может строиться по другому источнику
function comparisonPanel(comparison, accountSource) {
  const sec = panel('Аккаунт vs локальные реплеи',
    'аккаунт по источнику ' + accountSource + ' · напрямую не сравниваются');
  sec.appendChild(barRow('Аккаунт', comparison.accountWinRate, fmtPercent(comparison.accountWinRate), 'var(--air)'));
  sec.appendChild(barRow('WRPL', comparison.replayWinRate, fmtPercent(comparison.replayWinRate), 'var(--air)'));
  const rows = el('div');
  rows.style.marginTop = '6px';
  rows.appendChild(row('Ориентировочная разница', comparison.indicativeWinRateDifference === null
    ? '—'
    : (comparison.indicativeWinRateDifference * 100).toFixed(1) + ' п.п.'));
  rows.appendChild(row('Совпавшая техника', fmtMetric(comparison.vehicleOverlapCount)));
  sec.appendChild(rows);
  sec.appendChild(el('div', 'muted small', comparison.note));
  return sec;
}
// Запасной вывод, если структура totals не распознана (например, новая схема источника)
function rawTotalsPanel(account) {
  if (!account.totals || !account.totals.length) return null;
  const sec = panel('Итоги · ' + account.source, 'неструктурированные строки');
  account.totals.slice(0, 10).forEach(function (t) {
    const label = [t.gameType, t.mode, t.category].filter(Boolean).join(' / ') || 'аккаунт';
    const counters = t.battles === null && t.victories === null
      ? 'выходов ' + fmtMetric(t.respawns)
      : 'бои ' + fmtMetric(t.battles) + ' · победы ' + fmtMetric(t.victories)
        + ' · смерти ' + fmtMetric(t.deaths);
    sec.appendChild(row(label, counters + ' · время ' + fmtHours(t.timePlayedSec)));
  });
  if (account.totalsTruncated) sec.appendChild(row('итоги', 'показаны первые 100 строк'));
  return sec;
}
function renderPlayerStats(stats) {
  const root = document.getElementById('player-stats-result');
  const frag = document.createDocumentFragment();
  frag.appendChild(playerHeader(stats));

  const sources = Array.isArray(stats.accountSources) && stats.accountSources.length
    ? stats.accountSources
    : [stats.account];

  // KPI и таблица режимов строятся по первому источнику с агрегатной строкой
  let kpiAccount = null, kpiTotal = null;
  sources.forEach(function (account) {
    if (kpiTotal) return;
    const t = aggregateTotal(account);
    if (t) { kpiAccount = account; kpiTotal = t; }
  });
  if (kpiTotal) {
    frag.appendChild(accountKpis(kpiAccount, kpiTotal));
    const deltaByTotal = new Map();
    if (kpiAccount.delta) {
      kpiAccount.delta.totals.forEach(function (total) {
        deltaByTotal.set(JSON.stringify([total.gameType, total.mode, total.category]), total);
      });
    }
    const modes = modeTablePanel(kpiAccount, deltaByTotal);
    if (modes) frag.appendChild(modes);
  } else {
    sources.forEach(function (account) {
      const raw = rawTotalsPanel(account);
      if (raw) frag.appendChild(raw);
    });
  }

  const branches = branchSpawnsPanel(sources);
  if (branches) frag.appendChild(branches);

  frag.appendChild(sourcesPanel(sources));

  // Техника есть только у StatShark; берём первый источник с непустым списком
  const vehicleSource = sources.find(function (a) { return Array.isArray(a.vehicles) && a.vehicles.length; });
  if (vehicleSource) {
    const vehicles = vehiclesPanel(vehicleSource);
    if (vehicles) frag.appendChild(vehicles);
  }

  frag.appendChild(replayPanel(stats.replay));
  frag.appendChild(comparisonPanel(stats.comparison, stats.account.source));

  sources.forEach(function (account) {
    if (!account.error) return;
    frag.appendChild(el('div', 'notice fail small', account.source + ': ' + account.error));
  });

  root.replaceChildren(frag);
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
    const accountSources = Array.isArray(payload.stats.accountSources) && payload.stats.accountSources.length
      ? payload.stats.accountSources
      : [payload.stats.account];
    const refreshQueued = accountSources.some(function (account) { return account.refreshQueued; });
    const failedAccount = accountSources.find(function (account) {
      return ['private', 'not_found', 'rate_limited', 'schema_error', 'error'].includes(account.state);
    });
    if (refreshQueued && attempt < 9) {
      status.className = 'muted small';
      status.textContent = 'Локальные WRPL готовы; внешний snapshot обновляется…';
      window.setTimeout(function () { loadPlayerStats(input, token, attempt + 1); }, 2500);
    } else if (refreshQueued) {
      status.className = 'muted small';
      status.textContent = 'Внешнее обновление ещё выполняется; повторите поиск через несколько секунд.';
    } else if (failedAccount) {
      status.className = 'fail small';
      status.textContent = 'Локальные WRPL получены, внешний snapshot недоступен: '
        + failedAccount.source + ' — ' + accountStateLabel(failedAccount.state) + '.';
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

function renderSeason(season) {
  const status = document.getElementById('season-status');
  if (!season || !season.season) {
    status.textContent = 'Сезон: расписание не задано';
  } else if (season.currentStage) {
    status.textContent =
      season.season.name + ' · ' +
      (season.currentStage.endsAt === season.season.endsAt ? 'до конца сезона' : season.currentStage.week + ' неделя') +
      ' · макс. БР ' + Number(season.currentStage.maxBr).toFixed(1) + ' · ' +
      new Date(season.currentStage.startsAt * 1000).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) + '–' +
      new Date((season.currentStage.endsAt - 1) * 1000).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
  } else {
    status.textContent = season.season.name + ' · сезон завершён';
  }
}

function renderRuntime(runtime) {
  const metrics = document.getElementById('runtime-metrics');
  const workerDetail = document.getElementById('worker-detail');
  const ingestDetail = document.getElementById('ingest-detail');
  const workloadsRoot = document.getElementById('worker-workloads');
  const playerServicesRoot = document.getElementById('player-stats-services');
  if (!runtime) {
    metrics.replaceChildren(el('div', 'muted small', 'Runtime-телеметрия недоступна в этом режиме запуска.'));
    workerDetail.replaceChildren();
    ingestDetail.replaceChildren();
    workloadsRoot.replaceChildren();
    playerServicesRoot.replaceChildren();
    return;
  }

  const process = runtime.process;
  const workers = runtime.workers;
  const liveIngest = runtime.ingest;
  metrics.replaceChildren(
    metricBox('RSS процесса', fmtBytes(process.rssBytes),
      'heap ' + fmtBytes(process.heapUsedBytes) + ' / ' + fmtBytes(process.heapTotalBytes),
      runtime.resources.totalMemoryMb > 0 ? process.rssBytes / (runtime.resources.totalMemoryMb * 1024 * 1024) : null),
    metricBox('CPU процесса', process.cpuPercent.toFixed(1) + '%',
      'Node ' + process.node + ' · PID ' + process.pid, Math.min(1, process.cpuPercent / 100)),
    metricBox('Event loop', fmtMs(runtime.eventLoop.currentLagMs),
      'максимум ' + fmtMs(runtime.eventLoop.maxLagMs),
      Math.min(1, runtime.eventLoop.currentLagMs / 500),
      runtime.eventLoop.currentLagMs > 100 ? 'var(--fail)' : 'var(--ok)'),
    metricBox('CPU workers', workers.busy + ' / ' + workers.configured,
      workers.ready + ' ready · ' + workers.queued + ' в очереди',
      workers.configured ? workers.busy / workers.configured : 0),
    metricBox('Ingest', liveIngest.battlesPerMinute.toFixed(1) + ' боёв/мин',
      'concurrency ' + (liveIngest.admission ? liveIngest.admission.currentConcurrency : runtime.resources.ingestConcurrency)),
    metricBox('Replay budget', fmtBytes(liveIngest.processBudget.usedBytes),
      'из ' + fmtBytes(liveIngest.processBudget.limitBytes) + ' · waiters ' + liveIngest.processBudget.queuedCount,
      liveIngest.processBudget.limitBytes ? liveIngest.processBudget.usedBytes / liveIngest.processBudget.limitBytes : 0)
  );

  const workerSuccessRate = workers.completed > 0 ? workers.succeeded / workers.completed : null;
  workerDetail.replaceChildren(
    row('слоты live / ready', workers.live + ' / ' + workers.ready),
    row('busy / queued', workers.busy + ' / ' + workers.queued, workers.queued ? 'fail' : 'ok'),
    row('задачи завершены', fmtMetric(workers.completed)),
    row('успех', workerSuccessRate === null ? '—' : fmtPercent(workerSuccessRate)),
    row('ошибки / отклонено', fmtMetric(workers.failed) + ' / ' + fmtMetric(workers.rejected),
      workers.failed || workers.rejected ? 'fail' : 'muted'),
    row('queue avg / max', fmtMs(workers.queueMsAvg) + ' / ' + fmtMs(workers.queueMsMax)),
    row('execution avg / max', fmtMs(workers.executionMsAvg) + ' / ' + fmtMs(workers.executionMsMax)),
    row('буферы queued / running', fmtBytes(workers.queuedBytes) + ' / ' + fmtBytes(workers.runningBytes))
  );

  const stages = liveIngest.stages;
  const stageText = ['download', 'ready', 'parse', 'persist'].map(function (name) {
    const stage = stages[name];
    return name + ' ' + stage.active + '/' + stage.queued;
  }).join(' · ');
  const oldest = liveIngest.backlog.oldestAgeMs === null ? '—' : fmtMs(liveIngest.backlog.oldestAgeMs);
  ingestDetail.replaceChildren(
    row('очередь DB / oldest', fmtMetric(liveIngest.backlog.pending) + ' / ' + oldest,
      liveIngest.backlog.pending ? 'fail' : 'ok'),
    row('active / queued по этапам', stageText),
    row('parse p95', fmtMs(stages.parse.activeP95Ms)),
    row('replay ok / fail', fmtMetric(liveIngest.replay.succeeded) + ' / ' + fmtMetric(liveIngest.replay.failed),
      liveIngest.replay.failed ? 'fail' : 'muted'),
    row('CDN данные / retry', fmtBytes(liveIngest.replay.bytes) + ' / ' + fmtMetric(liveIngest.replay.retries)),
    row('429 / 5xx', fmtMetric(liveIngest.replay.rateLimited429) + ' / ' + fmtMetric(liveIngest.replay.server5xx),
      liveIngest.replay.rateLimited429 || liveIngest.replay.server5xx ? 'fail' : 'muted'),
    row('SQLite commits / p95', fmtMetric(liveIngest.sqlite.commits) + ' / ' + fmtMs(liveIngest.sqlite.transactionP95Ms)),
    row('budget timeout / wait max', fmtMetric(liveIngest.processBudget.timedOut) + ' / ' +
      fmtMs(liveIngest.processBudget.waitMsMax), liveIngest.processBudget.timedOut ? 'fail' : 'muted'),
    row('fetch admission', liveIngest.fetchAdmission.currentIntervalMs + ' мс · rate limit ' +
      fmtMetric(liveIngest.fetchAdmission.rateLimitEvents)),
    row('AIMD', liveIngest.admission
      ? liveIngest.admission.currentConcurrency + '/' + liveIngest.admission.maxConcurrency + ' · ' + liveIngest.admission.reason
      : 'не запущен')
  );

  if (!workers.workloads.length) {
    workloadsRoot.className = 'muted small';
    workloadsRoot.textContent = 'CPU-задачи ещё не выполнялись';
  } else {
    workloadsRoot.className = '';
    const table = tableEl([
      { label: 'Задача' }, { label: 'Приоритет' }, { label: 'Active', num: true },
      { label: 'Queue', num: true }, { label: 'Готово', num: true },
      { label: 'Ошибки', num: true }, { label: 'Queue max', num: true },
      { label: 'Exec max', num: true }
    ]);
    workers.workloads.forEach(function (workload) {
      const tr = el('tr');
      tr.appendChild(el('td', null, workload.kind));
      tr.appendChild(el('td', 'muted', workload.priority));
      tr.appendChild(el('td', 'num', fmtMetric(workload.running)));
      tr.appendChild(el('td', 'num', fmtMetric(workload.queued)));
      tr.appendChild(el('td', 'num', fmtMetric(workload.completed)));
      tr.appendChild(el('td', 'num', fmtMetric(workload.failed + workload.rejected)));
      tr.appendChild(el('td', 'num', fmtMs(workload.queueMsMax)));
      tr.appendChild(el('td', 'num', fmtMs(workload.executionMsMax)));
      table.tbody.appendChild(tr);
    });
    workloadsRoot.replaceChildren(table.root);
  }

  if (!runtime.playerStats.length) {
    playerServicesRoot.className = 'muted small';
    playerServicesRoot.textContent = 'Внешние provider-ы отключены';
  } else {
    playerServicesRoot.className = '';
    const table = tableEl([
      { label: 'Источник' }, { label: 'Запросы', num: true }, { label: 'Поставлено', num: true },
      { label: 'Запущено', num: true }, { label: 'Успешно', num: true },
      { label: 'Ошибки', num: true }, { label: 'Fresh cache', num: true },
      { label: 'Backoff', num: true }
    ]);
    runtime.playerStats.forEach(function (service) {
      const tr = el('tr');
      tr.appendChild(el('td', null, service.source));
      tr.appendChild(el('td', 'num', fmtMetric(service.requests)));
      tr.appendChild(el('td', 'num', fmtMetric(service.queued)));
      tr.appendChild(el('td', 'num', fmtMetric(service.started)));
      tr.appendChild(el('td', 'num', fmtMetric(service.succeeded)));
      tr.appendChild(el('td', 'num', fmtMetric(service.failed)));
      tr.appendChild(el('td', 'num', fmtMetric(service.skippedFresh)));
      tr.appendChild(el('td', 'num', fmtMetric(service.skippedBackoff)));
      table.tbody.appendChild(tr);
    });
    playerServicesRoot.replaceChildren(table.root);
  }
}

function renderDashboard(data) {
  document.getElementById('bot-dot').className = 'dot ' + (data.bot.online ? 'on' : 'off');
  document.getElementById('bot-tag').textContent = data.bot.tag || 'offline';
  const snapshotAge = Math.max(0, data.generatedAt - data.snapshotAt);
  const freshness = document.getElementById('dashboard-freshness');
  freshness.className = 'muted small';
  freshness.textContent =
    'Снимок ' + new Date(data.snapshotAt).toLocaleTimeString('ru') +
    (snapshotAge > 1000 ? ' · возраст ' + Math.round(snapshotAge / 1000) + ' с' : '') +
    ' · автообновление 15 с';

  const overview = document.getElementById('overview-metrics');
  overview.replaceChildren(
    metricBox('Discord', data.bot.online ? 'online' : 'offline',
      fmtMetric(data.bot.guilds) + ' серверов · uptime ' + fmtUptime(data.bot.uptimeSec),
      data.bot.online ? 1 : 0, data.bot.online ? 'var(--ok)' : 'var(--fail)'),
    metricBox('Разобрано боёв', fmtMetric(data.ingest.ingested),
      'ingest: ' + fmtMetric(data.ingest.pending) + ' в очереди · ' + fmtMetric(data.ingest.failed) + ' failed'),
    metricBox('Автоанонс', fmtMetric(data.announce.pending),
      fmtMetric(data.announce.unattempted) + ' новых · ' + fmtMetric(data.announce.retrying) + ' retry'),
    metricBox('Участники', fmtMetric(data.ingest.players),
      fmtMetric(data.ingest.kills) + ' убийств в датасете'),
    metricBox('Записи источников', fmtMetric(data.items.total),
      fmtMetric(data.items.bySource.length) + ' источников · ' + fmtMetric(data.parsers.length) + ' парсеров')
  );

  document.getElementById('cmd-total').textContent = fmtMetric(data.commands.total);
  const cmdList = document.getElementById('cmd-list');
  cmdList.replaceChildren.apply(cmdList, data.commands.byCommand.slice(0, 8).map(function (command) {
    return row('/' + command.command, fmtMetric(command.count));
  }));

  document.getElementById('items-total').textContent = fmtMetric(data.items.total);
  const bySource = document.getElementById('items-by-source');
  bySource.replaceChildren.apply(bySource, data.items.bySource.slice(0, 8).map(function (source) {
    return row(source.source, fmtMetric(source.count));
  }));

  const transport = data.wtTransport;
  document.getElementById('transport-mode').textContent = transport.mode;
  const transportRoutes = Object.keys(transport.routes || {}).map(function (route) {
    const mode = transport.routes[route];
    return row(route, mode, mode === 'direct' ? 'ok' : mode === 'browser' ? '' : 'muted');
  });
  document.getElementById('transport-detail').replaceChildren.apply(document.getElementById('transport-detail'), transportRoutes.concat([
    row('browser pool', fmtMetric(transport.poolSize)),
    row('запросы', fmtMetric(transport.requests)),
    row('challenge', fmtMetric(transport.challenged), transport.challenged ? 'fail' : 'muted'),
    row('transport errors', fmtMetric(transport.transportErrors), transport.transportErrors ? 'fail' : 'muted'),
    row('clearance ok / fail', fmtMetric(transport.clearances) + ' / ' + fmtMetric(transport.clearanceFailures)),
    row('clearance probes', fmtMetric(transport.clearanceProbes)),
    row('последний clearance', transport.lastClearanceAt ? fmtTimestamp(Math.floor(transport.lastClearanceAt / 1000)) : '—')
  ]));

  renderSeason(data.season);
  const voiceList = document.getElementById('voice-list');
  if (data.voice.channels.length === 0) {
    voiceList.classList.add('muted');
    voiceList.textContent = 'В отслеживаемых голосовых каналах никого нет';
  } else {
    voiceList.classList.remove('muted');
    voiceList.replaceChildren.apply(voiceList, data.voice.channels.map(voiceChannelBlock));
  }

  const parserList = document.getElementById('parser-list');
  if (data.parsers.length === 0) {
    parserList.className = 'muted';
    parserList.textContent = 'Парсеры ещё не запускались';
  } else {
    parserList.className = '';
    parserList.replaceChildren.apply(parserList, data.parsers.map(function (parser) {
      const text = (parser.summary || parser.error || '?') + ' · ' + fmtTimestamp(parser.parsedAt);
      return row(parser.source, text, parser.ok ? 'ok' : 'fail');
    }));
  }

  const itemList = document.getElementById('item-list');
  if (data.recentItems.length === 0) {
    itemList.className = 'muted';
    itemList.textContent = 'Записей пока нет — парсеры ещё не принесли данные';
  } else {
    itemList.className = '';
    itemList.replaceChildren.apply(itemList, data.recentItems.map(itemRow));
  }
  renderRuntime(data.runtime);
}

function renderSiteStats(data) {
  document.getElementById('site-battles').textContent = fmtMetric(data.battlesTotal);
  document.getElementById('site-detail').replaceChildren(
    row('боёв за неделю', fmtMetric(data.battlesWeek)),
    row('уникальных игроков', fmtMetric(data.players)),
    row('полков', fmtMetric(data.clans)),
    row('последний бой', fmtTimestamp(data.lastBattleAt))
  );
  const activity = document.getElementById('site-activity');
  const byDay = new Map(data.byDay.map(function (point) { return [point.day, point.battles]; }));
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    days.push({ day: day, battles: byDay.get(day) || 0 });
  }
  const max = Math.max.apply(Math, [1].concat(days.map(function (point) { return point.battles; })));
  activity.className = 'activity';
  activity.replaceChildren.apply(activity, days.map(function (point) {
    const col = el('div', 'activity-col');
    const value = el('div', 'small', fmtMetric(point.battles));
    const bar = el('div', 'activity-bar');
    bar.style.height = Math.max(2, Math.round(point.battles / max * 62)) + 'px';
    bar.title = point.day + ': ' + point.battles;
    const label = el('div', null, new Date(point.day + 'T00:00:00Z').toLocaleDateString('ru', {
      weekday: 'short', timeZone: 'UTC'
    }));
    col.append(value, bar, label);
    return col;
  }));
}

let dashboardTimer = null;
let siteTimer = null;
let dashboardBusy = false;
let siteBusy = false;

async function refreshDashboard(force) {
  if (dashboardBusy) return;
  dashboardBusy = true;
  let nextDelay = 15000;
  try {
    const response = await fetch('/api/dashboard', {
      headers: { accept: 'application/json' },
      cache: force ? 'reload' : 'default'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    renderDashboard(data);
    nextDelay = Math.max(10000, Number(data.refreshAfterMs) || 15000);
  } catch (error) {
    console.error(error);
    document.getElementById('dashboard-freshness').className = 'fail small';
    document.getElementById('dashboard-freshness').textContent = 'Не удалось обновить дэшборд';
    nextDelay = 30000;
  } finally {
    dashboardBusy = false;
    if (document.visibilityState === 'visible') {
      window.clearTimeout(dashboardTimer);
      dashboardTimer = window.setTimeout(function () { refreshDashboard(false); }, nextDelay);
    }
  }
}

async function refreshSiteStats() {
  if (siteBusy) return;
  siteBusy = true;
  let nextDelay = 60000;
  try {
    const response = await fetch('/api/site-stats', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    renderSiteStats(await response.json());
  } catch (error) {
    console.error(error);
    nextDelay = 120000;
  } finally {
    siteBusy = false;
    if (document.visibilityState === 'visible') {
      window.clearTimeout(siteTimer);
      siteTimer = window.setTimeout(refreshSiteStats, nextDelay);
    }
  }
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') {
    window.clearTimeout(dashboardTimer);
    window.clearTimeout(siteTimer);
    return;
  }
  refreshDashboard(false);
  refreshSiteStats();
});

refreshDashboard(false);
refreshSiteStats();

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
    await refreshDashboard(true);
  } catch (e) { console.error(e); }
  btn.disabled = false;
  btn.textContent = 'Обновить';
});
</script>
<footer class="muted" style="margin-top:22px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;text-align:center">
  wtbot — свободное ПО на условиях <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL-3.0-or-later</a>.
  Исходный код: <a href="https://github.com/Irenid/wtbot">github.com/Irenid/wtbot</a>
</footer>
</body>
</html>`

/** The bot dashboard; the SPA owns the root and links here from its top bar (frontend/src/App.tsx). */
export const DASHBOARD_PATH = '/statistics'

export const pageRoutes: FastifyPluginAsync = async (app) => {
  app.get(DASHBOARD_PATH, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(dashboardHtml)
  })
}
