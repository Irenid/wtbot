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
</style>
</head>
<body>
<div class="wrap">
  <h1>wtbot</h1>
  <div class="sub">Панель управления — обновляется каждые 10 секунд</div>
  <div class="grid">
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
async function refresh() {
  try {
    const responses = await Promise.all([fetch('/api/stats'), fetch('/api/items?limit=8')]);
    const data = await responses[0].json();
    const itemsData = await responses[1].json();

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
</script>
</body>
</html>`

export const pageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(dashboardHtml)
  })
}
