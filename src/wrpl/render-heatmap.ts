import type { MissileSeeker } from './battle-assets.js'
import type { MissionInfo } from './mission-info.js'
import type { ReplayEvents, ReplayKill, ReplayUnitPath, SpaceTime } from './replay-events.js'
import type { ReplayResults, WrplHeader } from './replay.js'
import { buildRosters, tagMarkup } from './render-battle.js'
import { vehicleInfo, type VehicleDict } from './vehicles.js'

/**
 * Хитмапа боя в стиле Boris Stats: траектории игроков поверх карты,
 * черепа в цвете погибшего со значком причины смерти (силуэт класса
 * убийцы: танк/самолёт/вертолёт/зенитка; для авиации — тип ГСН ракеты
 * ИК/ПАРЛ/АРЛ/ЗУР; звезда — разбился; ободок — цвет убийцы), пунктирные
 * линии фрагов от убийцы к жертве, пятна долгих стоянок с длительностью,
 * точки в конце пути выживших, метки минут вдоль траекторий, ромбы зон
 * захвата (A/B/C из файла миссии). Справа — информационная панель:
 * карта/режим/дата, команды в порядке сторон на карте (победитель,
 * игроки с фрагами/смертями, техникой, очками и временем гибели) и
 * блок условных обозначений.
 *
 * mode='ground' — наземная техника (GMSync), mode='air' — авиация
 * (пакеты лётной модели). Наземная карта занимает весь кадр (ровно
 * battleArea); воздушная — по габаритам траекторий, battleArea на ней
 * маленький квадрат. Без файла миссии — по габаритам траекторий.
 *
 * Слои снизу вверх, по важности: карта → траектории → пятна стоянок →
 * метки минут → зоны A/B/C → пунктир фрагов → точки выживших → черепа →
 * значки причин → подписи техники. Самое важное (события смертей)
 * ничем не перекрывается.
 *
 * Фон — снимок игровой тактической карты нужного режима (см.
 * ensureTacticalMap: качается по missionName, покрывает ровно battleArea);
 * если его нет — ручной скриншот data/maps/<level>.jpg, растянутый на
 * battleArea; иначе тёмная подложка с сеткой.
 */

const MAP_W = 1400
/** Ширина информационной панели справа от карты */
const PANEL_W = 480

/**
 * Палитра траекторий: 16 уникальных цветов, подобраны жадным max-min
 * поиском по OKLab ΔE (обычное зрение + протан/дейтан-симуляция Machado)
 * на фоне хаки-карты; разбиение на команды максимизирует различимость
 * внутри команды — межкомандные пары дополнительно разводит легенда.
 */
const PATH_COLORS = [
  ['#f04a50', '#f57d1f', '#ffd08a', '#19c2c9', '#a8ecff', '#a86ef5', '#ff8fd0', '#ffffff'],
  ['#f2c811', '#c9f25e', '#37c463', '#12dfae', '#c8cdd6', '#cfa4ff', '#f24ab2', '#ffb3a6'],
]

const FONTS = `Segoe UI, Segoe UI Symbol, Microsoft YaHei, Malgun Gothic, Yu Gothic UI, Arial, sans-serif`

export interface HeatmapInput {
  /** " [Domination #2] North Holland" — по нему ищется снимок карты */
  missionName: string
  header: WrplHeader
  results: ReplayResults
  events: ReplayEvents
  dict: VehicleDict
  mission: MissionInfo | null
  mode: 'ground' | 'air'
  /** Индекс команды из buildRosters; без значения рисуются обе команды. */
  teamIndex?: number
  /** Тип ГСН по id оружия (для значков причины смерти) */
  seekers?: Map<string, MissileSeeker>
}

interface PlayerPaths {
  userId: string
  name: string
  clanTag: string
  color: string
  models: string[]
  paths: ReplayUnitPath[]
  team: number
}

/** "tankModels/ussr_2s38" → "ussr_2s38" (ключ словаря техники) */
const modelId = (model: string): string => model.replace(/^.*\//, '')

export function buildHeatmapSvg(
  input: HeatmapInput,
  gameFont = false,
  tacticalMap: string | null = null,
  fallbackMap: string | null = null,
): string {
  const { events, results, dict, mission, mode, seekers, teamIndex } = input

  // Игроки в порядке команд со скриншота результатов (слева — «золотая»)
  const rosters = buildRosters(results)
  const allPlayers: PlayerPaths[] = []
  rosters.forEach((roster, ti) => {
    roster.forEach((p, pi) => {
      const paths = events.units
        .filter((u) => u.userId === p.userId && u.source === mode && u.path.length >= 2)
        .map((u) => (mode === 'air' ? truncateAtDeath(u, events, p.userId) : u))
        .filter((u) => u.path.length >= 2)
      if (paths.length === 0) return
      allPlayers.push({
        userId: p.userId,
        name: p.name.replace(/@(psn|live|epic)$/i, ''),
        clanTag: p.clanTag,
        color: PATH_COLORS[Math.min(ti, 1)]![pi % 8]!,
        models: [...new Set(paths.map((q) => modelId(q.model)))],
        paths,
        team: ti,
      })
    })
  })
  const players = teamIndex === undefined ? allPlayers : allPlayers.filter((player) => player.team === teamIndex)

  // Границы мира: battleArea миссии, иначе габариты траекторий; всегда квадрат.
  // Наземная карта с известным battleArea кладётся на весь кадр (снимок
  // покрывает ровно его), остальные режимы — с небольшим полем.
  // Масштаб командной карты совпадает с общей: границы считаются по обеим
  // командам, а цвета назначаются до фильтрации.
  const allPoints = allPlayers.flatMap((p) => p.paths.flatMap((q) => q.path))
  let bounds = mission?.area ?? null
  const fullBleed = mode === 'ground' && bounds !== null
  if (!fullBleed) {
    bounds = fitBounds(allPoints, bounds)
  }
  const cx = (bounds!.x0 + bounds!.x1) / 2
  const cz = (bounds!.z0 + bounds!.z1) / 2
  const half = Math.max(bounds!.x1 - bounds!.x0, bounds!.z1 - bounds!.z0) / 2 || 1000
  const view = fullBleed ? 1 : 0.94
  // мир → пиксели; Z растёт на север, на картинке — вверх
  const px = (x: number): number => ((x - cx) / half) * (MAP_W / 2) * view + MAP_W / 2
  const pz = (z: number): number => MAP_W / 2 - ((z - cz) / half) * (MAP_W / 2) * view

  const W = MAP_W + PANEL_W
  const H = MAP_W

  const parts: string[] = []
  parts.push(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`)

  // Фон карты: снимок игровой карты режима → ручной скриншот → сетка.
  // Оба изображения покрывают ровно battleArea, поэтому кладутся на его
  // прямоугольник в мировых координатах (на воздушной карте он меньше кадра).
  const mapImage = tacticalMap ?? fallbackMap
  parts.push(`<rect width="${MAP_W}" height="${MAP_W}" fill="#3c4034"/>`)
  if (mapImage && mission?.area) {
    const a = mission.area
    const ix = px(a.x0)
    const iy = pz(a.z1)
    const iw = px(a.x1) - ix
    const ih = pz(a.z0) - iy
    parts.push(
      `<image x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" preserveAspectRatio="none" href="${mapImage}"/>`,
      // лёгкое затемнение — чтобы траектории читались поверх карты
      `<rect x="${r1(ix)}" y="${r1(iy)}" width="${r1(iw)}" height="${r1(ih)}" fill="#0a0e14" fill-opacity="0.18"/>`,
    )
  } else if (mapImage) {
    parts.push(`<image x="0" y="0" width="${MAP_W}" height="${MAP_W}" preserveAspectRatio="xMidYMid slice" href="${mapImage}"/>`)
  } else {
    // подложка с сеткой
    parts.push(`<rect width="${MAP_W}" height="${MAP_W}" fill="#41453a"/>`)
    const cells = 10
    for (let i = 0; i <= cells; i++) {
      const v = (MAP_W / cells) * i
      parts.push(
        `<line x1="${v}" y1="0" x2="${v}" y2="${MAP_W}" stroke="#2d3028" stroke-width="1.5"/>`,
        `<line x1="0" y1="${v}" x2="${MAP_W}" y2="${v}" stroke="#2d3028" stroke-width="1.5"/>`,
      )
    }
  }

  // Рамка battleArea (важно на воздушной карте, где мир шире зоны боя;
  // при карте на весь кадр совпадает с границей и не рисуется)
  if (mission?.area && !fullBleed) {
    const a = mission.area
    const fx = px(a.x0)
    const fy = pz(a.z1)
    parts.push(
      `<rect x="${r1(fx)}" y="${r1(fy)}" width="${r1(px(a.x1) - fx)}" height="${r1(pz(a.z0) - fy)}" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.5" stroke-dasharray="14 10"/>`,
    )
  }

  // Траектории: тёмная подложка + цветная линия
  for (const p of players) {
    for (const unit of p.paths) {
      for (const seg of splitSegments(unit.path)) {
        const d = seg.map((q, i) => `${i === 0 ? 'M' : 'L'}${r1(px(q.x))} ${r1(pz(q.z))}`).join('')
        parts.push(
          `<path d="${d}" fill="none" stroke="#10130d" stroke-opacity="0.55" stroke-width="5.4" stroke-linejoin="round" stroke-linecap="round"/>`,
        )
        parts.push(
          `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
        )
      }
    }
  }

  // Время первой смерти игрока в пределах жизни юнита: остов подбитой
  // машины шлёт статичную позицию до конца боя — без обрезки по смерти
  // он превратился бы в ложную «стоянку»
  const deathTimeOf = (p: PlayerPaths, unit: ReplayUnitPath): number | null => {
    const start = unit.path[0]!.t
    const end = unit.path[unit.path.length - 1]!.t
    const kill = events.kills.find(
      (k) => k.victimId === p.userId && k.time >= start - 5000 && k.time <= end + 45000,
    )
    return kill ? kill.time : null
  }

  // Стоянки (только наземка): где юнит простоял дольше минуты — пятно
  // в цвете игрока (размер растёт с длительностью) с подписью «м:сс»
  if (mode === 'ground') {
    for (const p of players) {
      for (const unit of p.paths) {
        const death = deathTimeOf(p, unit)
        const alive = death === null ? unit.path : unit.path.filter((q) => q.t <= death)
        if (alive.length < 2) continue
        for (const camp of findCamps(alive)) {
          const r = Math.min(30, 13 + (camp.durMs / 60000) * 5)
          const mm = Math.floor(camp.durMs / 60000)
          const ss = String(Math.floor((camp.durMs % 60000) / 1000)).padStart(2, '0')
          const x = r1(px(camp.x))
          const y = pz(camp.z)
          parts.push(
            `<circle cx="${x}" cy="${r1(y)}" r="${r1(r)}" fill="${p.color}" fill-opacity="0.26" stroke="${p.color}" stroke-opacity="0.85" stroke-width="1.8"/>`,
            `<text x="${x}" y="${r1(y + r + 17)}" font-family="${FONTS}" font-size="14.5" font-weight="700" text-anchor="middle" fill="none" stroke="#10130d" stroke-width="3.4">${mm}:${ss}</text>`,
            `<text x="${x}" y="${r1(y + r + 17)}" font-family="${FONTS}" font-size="14.5" font-weight="700" text-anchor="middle" fill="#f2f4f7">${mm}:${ss}</text>`,
          )
        }
      }
    }
  }

  // Метки времени: кружок с номером минуты раз в tickStep минут вдоль
  // каждой траектории; у стоящего юнита слипшиеся метки пропускаются —
  // остаётся время прибытия в точку
  const endTime = Math.max(events.endTime, ...allPoints.map((q) => q.t), 1)
  const stepMs = tickStepMinutes(endTime) * 60000
  for (const p of players) {
    for (const unit of p.paths) {
      let lastX = -1e9
      let lastY = -1e9
      for (const tick of timeTicks(unit.path, stepMs)) {
        const x = px(tick.x)
        const y = pz(tick.z)
        if (Math.hypot(x - lastX, y - lastY) < 27) continue
        lastX = x
        lastY = y
        parts.push(
          `<g transform="translate(${r1(x)} ${r1(y)})">` +
            `<circle r="11" fill="#10130d" fill-opacity="0.74" stroke="${p.color}" stroke-width="2.4"/>` +
            `<text y="4.6" font-family="${FONTS}" font-size="13" font-weight="700" fill="#f2f4f7" text-anchor="middle">${tick.minute}</text>` +
            `</g>`,
        )
      }
    }
  }

  // Зоны захвата — ромбы с буквами; масштаб — от размера зоны боя в кадре
  // (на воздушной карте battleArea занимает маленький квадрат)
  const areaPx = mission?.area ? px(mission.area.x1) - px(mission.area.x0) : MAP_W
  const zoneScale = Math.max(0.32, Math.min(1, areaPx / 900))
  for (const zone of mission?.zones ?? []) {
    parts.push(
      `<g transform="translate(${r1(px(zone.x))} ${r1(pz(zone.z))}) scale(${zoneScale})">` +
        `<rect x="-19" y="-19" width="38" height="38" rx="4" transform="rotate(45)" fill="#4d8fd1" stroke="#dbe9f7" stroke-width="2.5"/>` +
        `<text x="0" y="10" font-family="${FONTS}" font-size="28" font-weight="700" fill="#0d1524" text-anchor="middle">${zone.letter}</text>` +
        `</g>`,
    )
  }

  // Смерти: череп на месте каждого убийства этого игрока (в рамках путей
  // данного режима, в цвете погибшего), значок и подпись причины,
  // пунктирная линия фрага от позиции убийцы; точка — конец пути юнита,
  // дожившего до конца боя. Подслои снизу вверх: линии фрагов → точки
  // выживших → черепа → значки → подписи, чтобы соседний череп в свалке
  // не накрывал чужой значок, а значки — подписи.
  const killLines: string[] = []
  const survivorDots: string[] = []
  const skulls: string[] = []
  const causeBadges: string[] = []
  const causeLabels: string[] = []
  const playerById = new Map(allPlayers.map((p) => [p.userId, p]))
  for (const p of players) {
    const ranges = p.paths.map((u) => ({
      from: u.path[0]!.t - 5000,
      to: u.path[u.path.length - 1]!.t + 45000,
      last: u.path[u.path.length - 1]!,
    }))
    for (const k of events.kills) {
      if (k.victimId !== p.userId) continue
      const range = ranges.find((rg) => k.time >= rg.from && k.time <= rg.to)
      if (!range) continue
      const pos = k.victimPos && isNear(k.victimPos, range.last) ? k.victimPos : nearestPoint(p.paths, k.time)
      if (!pos) continue
      skulls.push(skullIcon(px(pos.x), pz(pos.z), p.color))
      if (!k.killerId || k.killerId === p.userId) {
        causeBadges.push(causeBadge(px(pos.x) + 15, pz(pos.z) + 14, { icon: 'crash' }, '#8a919e'))
        continue
      }
      const killer = playerById.get(k.killerId)
      const cause = deathCause(k, mode, dict, seekers)
      if (cause) {
        causeBadges.push(causeBadge(px(pos.x) + 15, pz(pos.z) + 14, cause, killer?.color ?? '#8a919e'))
      }
      if (!killer) {
        // убийцы нет на этой карте (зенитка на воздушной, самолёт на
        // наземной) — цветом его не опознать, подписываем его технику
        const who = vehicleInfo(dict, modelId(k.killerModel)).name
        causeLabels.push(killerLabel(px(pos.x), pz(pos.z) + 34, trimTo(who, 18)))
      }
      // Позиция убийцы: точка его пути в момент фрага; если пути на этой
      // карте нет (авиация на наземной, зенитка на воздушной) — позиция
      // из события. Убийца за кадром — линия обрезается по краю карты
      // (видно направление атаки), точка его позиции тогда не рисуется.
      const from =
        (killer ? (pointAtTime(killer.paths, k.time) ?? nearestPoint(killer.paths, k.time)) : null) ??
        k.killerPos
      if (!from) continue
      let fx = px(from.x)
      let fy = pz(from.z)
      const tx = px(pos.x)
      const ty = pz(pos.z)
      let clipped = false
      if (fx < 0 || fx > MAP_W || fy < 0 || fy > MAP_W) {
        const t = Math.max(
          fx < 0 ? -fx / (tx - fx) : fx > MAP_W ? (MAP_W - fx) / (tx - fx) : 0,
          fy < 0 ? -fy / (ty - fy) : fy > MAP_W ? (MAP_W - fy) / (ty - fy) : 0,
        )
        if (!Number.isFinite(t) || t <= 0 || t >= 1) continue
        fx += (tx - fx) * t
        fy += (ty - fy) * t
        clipped = true
      }
      const lineColor = killer?.color ?? '#8a919e'
      killLines.push(
        `<line x1="${r1(fx)}" y1="${r1(fy)}" x2="${r1(tx)}" y2="${r1(ty)}" stroke="${lineColor}" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"/>`,
      )
      if (!clipped) {
        killLines.push(`<circle cx="${r1(fx)}" cy="${r1(fy)}" r="4.5" fill="${lineColor}" stroke="#10130d" stroke-width="1.6"/>`)
      }
    }
    for (const unit of p.paths) {
      const last = unit.path[unit.path.length - 1]!
      // подбитая машина остаётся в мире и шлёт статичную позицию —
      // конец пути возле места гибели точкой выжившего не считается
      const diedHere = events.kills.some(
        (k) =>
          k.victimId === p.userId &&
          (Math.abs(k.time - last.t) < 45000 || (k.victimPos !== null && isNear(k.victimPos, last, 60))),
      )
      if (!diedHere && events.endTime - last.t < 90000) {
        survivorDots.push(
          `<circle cx="${r1(px(last.x))}" cy="${r1(pz(last.z))}" r="8" fill="${p.color}" stroke="#10130d" stroke-width="2"/>`,
        )
      }
    }
  }

  // На поле карты одного клана показываем уничтоженных им противников только
  // точкой гибели, без чужого маршрута; в панели остаются оба состава.
  if (teamIndex !== undefined) {
    for (const killer of players) {
      for (const k of events.kills) {
        if (k.killerId !== killer.userId || k.victimId === killer.userId) continue
        const victim = playerById.get(k.victimId)
        if (!victim || victim.team === teamIndex) continue
        if (!killer.models.includes(modelId(k.killerModel)) || !victim.models.includes(modelId(k.victimModel))) continue

        const killerActive = killer.paths.some(
          (unit) => k.time >= unit.path[0]!.t - 5000 && k.time <= unit.path[unit.path.length - 1]!.t + 45000,
        )
        const victimRange = victim.paths
          .map((unit) => ({
            from: unit.path[0]!.t - 5000,
            to: unit.path[unit.path.length - 1]!.t + 45000,
            last: unit.path[unit.path.length - 1]!,
          }))
          .find((range) => k.time >= range.from && k.time <= range.to)
        if (!killerActive || !victimRange) continue

        const pos =
          k.victimPos && isNear(k.victimPos, victimRange.last)
            ? k.victimPos
            : nearestPoint(victim.paths, k.time)
        if (!pos) continue

        const tx = px(pos.x)
        const ty = pz(pos.z)
        skulls.push(skullIcon(tx, ty, victim.color))
        const cause = deathCause(k, mode, dict, seekers)
        if (cause) causeBadges.push(causeBadge(tx + 15, ty + 14, cause, killer.color))

        // Пунктир повторяет обозначение общей карты: цветом убийцы клана.
        const from = pointAtTime(killer.paths, k.time) ?? nearestPoint(killer.paths, k.time) ?? k.killerPos
        if (!from) continue
        let fx = px(from.x)
        let fy = pz(from.z)
        let clipped = false
        if (fx < 0 || fx > MAP_W || fy < 0 || fy > MAP_W) {
          const t = Math.max(
            fx < 0 ? -fx / (tx - fx) : fx > MAP_W ? (MAP_W - fx) / (tx - fx) : 0,
            fy < 0 ? -fy / (ty - fy) : fy > MAP_W ? (MAP_W - fy) / (ty - fy) : 0,
          )
          if (!Number.isFinite(t) || t <= 0 || t >= 1) continue
          fx += (tx - fx) * t
          fy += (ty - fy) * t
          clipped = true
        }
        killLines.push(
          `<line x1="${r1(fx)}" y1="${r1(fy)}" x2="${r1(tx)}" y2="${r1(ty)}" stroke="${killer.color}" stroke-width="1.8" stroke-opacity="0.8" stroke-dasharray="7 6"/>`,
        )
        if (!clipped) {
          killLines.push(`<circle cx="${r1(fx)}" cy="${r1(fy)}" r="4.5" fill="${killer.color}" stroke="#10130d" stroke-width="1.6"/>`)
        }
      }
    }
  }
  parts.push(...killLines, ...survivorDots, ...skulls, ...causeBadges, ...causeLabels)

  // Фраги/смерти за весь бой для легенды (самострел фрагом не считается)
  const killsDeaths = new Map<string, [number, number]>()
  for (const k of events.kills) {
    if (k.killerId && k.killerId !== k.victimId) {
      const e = killsDeaths.get(k.killerId) ?? [0, 0]
      e[0]++
      killsDeaths.set(k.killerId, e)
    }
    if (k.victimId) {
      const e = killsDeaths.get(k.victimId) ?? [0, 0]
      e[1]++
      killsDeaths.set(k.victimId, e)
    }
  }

  // ---------- панель справа: заголовок, команды, обозначения ----------
  parts.push(
    `<rect x="${MAP_W}" width="${PANEL_W}" height="${H}" fill="#0c0d0f"/>`,
    `<line x1="${MAP_W + 1}" y1="0" x2="${MAP_W + 1}" y2="${H}" stroke="#2a2e35" stroke-width="2"/>`,
  )
  const PX = MAP_W + 30
  const PR = MAP_W + PANEL_W - 30

  // Заголовок: карта, режим, дата и длительность боя
  const title = /^\s*(?:\[(?:arcade|realistic|simulation|hardcore)\]\s*)?(?:\[([^\]]+)\]\s*)?(.+)$/i.exec(
    input.missionName.trim(),
  )
  const gameMode = title?.[1] ?? 'Бой'
  const mapName = title?.[2] ?? input.missionName
  const when = new Date(input.header.startTime * 1000)
  const dateText =
    `${when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}, ` +
    when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const durText = endTime > 60000 ? ` · Длительность: ${fmtTime(endTime)}` : ''
  parts.push(
    `<text x="${PX}" y="66" font-family="${FONTS}" font-size="33" font-weight="700" fill="#ffffff">${esc(trimTo(mapName, 22))}</text>`,
    `<text x="${PX}" y="100" font-family="${FONTS}" font-size="19" fill="#9aa2b1">${esc(gameMode)} · ${mode === 'ground' ? 'наземная техника' : 'авиация'}</text>`,
    `<text x="${PX}" y="127" font-family="${FONTS}" font-size="19" fill="#9aa2b1">${esc(dateText)}${durText}</text>`,
    `<line x1="${PX}" y1="150" x2="${PR}" y2="150" stroke="#2a2e35" stroke-width="1.5"/>`,
  )

  // Медиана первых позиций игроков даёт устойчивую точку спавна команды.
  // Порядок в панели повторяет чтение карты: сверху вниз, затем слева направо.
  const teamSpawns = [0, 1].map((ti) => teamSpawn(allPlayers.filter((p) => p.team === ti), cx, cz, half))
  const orderTeams = [0, 1].sort((a, b) => {
    const sa = teamSpawns[a]
    const sb = teamSpawns[b]
    if (!sa || !sb) return sa ? -1 : sb ? 1 : a - b
    const dy = pz(sa.z) - pz(sb.z)
    return Math.abs(dy) > MAP_W * 0.15 ? dy : px(sa.x) - px(sb.x)
  })
  const resultById = new Map(rosters.flat().map((rp) => [rp.userId, rp]))

  let py = 192
  orderTeams.forEach((ti) => {
    const roster = rosters[ti]
    if (!roster) return
    // Панель всегда повторяет общую heatmap; teamIndex фильтрует только поле карты.
    const teamPlayers = allPlayers.filter((p) => p.team === ti)
    const clan = mostCommonTag(roster.map((rp) => rp.clanTag))
    const label = clan ? tagMarkup(clan, gameFont) : `Команда ${roster[0]?.team ?? ti + 1}`
    const won = events.teamWon > 0 && roster[0]?.team === events.teamWon
    const spawn = teamSpawns[ti]
    const spawnText = spawn?.label ?? ''
    parts.push(
      `<text x="${PX}" y="${py}" font-family="${FONTS}" font-size="29" font-weight="700" fill="${won ? '#f2c811' : '#ffffff'}">${label}</text>`,
      won
        ? `<text x="${PR}" y="${py}" font-family="${FONTS}" font-size="17" font-weight="700" text-anchor="end" fill="#f2c811">победа</text>`
        : '',
      `<text x="${PR}" y="${py + 21}" font-family="${FONTS}" font-size="16" text-anchor="end" fill="#9aa2b1">${spawnText}</text>`,
    )
    py += 30
    for (const p of teamPlayers) {
      const rp = resultById.get(p.userId)
      const [kills, deaths] = killsDeaths.get(p.userId) ?? [0, 0]
      const vehicles = p.models.map((m) => vehicleInfo(dict, m).name).join(', ')
      const deathsAt = events.kills.filter((k) => k.victimId === p.userId).map((k) => k.time)
      const fate = deathsAt.length > 0 ? `погиб ${fmtTime(Math.max(...deathsAt))}` : 'жив'
      const fateColor = deathsAt.length > 0 ? '#d98c8c' : '#9fd6a4'
      parts.push(
        `<rect x="${PX}" y="${py + 6}" width="20" height="20" rx="4" fill="${p.color}"/>`,
        `<text x="${PX + 32}" y="${py + 23}" font-family="${FONTS}" font-size="23" fill="#f2f4f7">${esc(trimTo(p.name, 18))}</text>`,
        `<text x="${PR}" y="${py + 23}" font-family="${FONTS}" font-size="21" font-weight="700" text-anchor="end" fill="#d7dce4">${kills}/${deaths}</text>`,
        `<text x="${PX + 32}" y="${py + 46}" font-family="${FONTS}" font-size="17" fill="#8f97a6">${esc(trimTo(vehicles, 27))}</text>`,
        `<text x="${PR}" y="${py + 46}" font-family="${FONTS}" font-size="17" text-anchor="end">` +
          (rp ? `<tspan fill="#8f97a6">${rp.score} очк. · </tspan>` : '') +
          `<tspan fill="${fateColor}">${fate}</tspan></text>`,
      )
      py += 58
    }
    if (teamPlayers.length === 0) {
      parts.push(
        `<text x="${PX}" y="${py + 20}" font-family="${FONTS}" font-size="18" fill="#5a616e">без траекторий в этом режиме</text>`,
      )
      py += 34
    }
    py += 30
  })

  // Обозначения — прижаты к низу панели, если осталось место
  const glyphColor = '#19c2c9'
  const symbols: [string, string][] = [
    [`<path d="M-11 4 C-5 -7, 3 9, 11 -2" fill="none" stroke="${glyphColor}" stroke-width="3" stroke-linecap="round"/>`, 'траектория'],
    [
      `<circle r="9" fill="#10130d" fill-opacity="0.74" stroke="${glyphColor}" stroke-width="2"/>` +
        `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">4</text>`,
      'минута боя',
    ],
    [`<circle r="9.5" fill="${glyphColor}" fill-opacity="0.26" stroke="${glyphColor}" stroke-width="1.6"/>`, 'стоянка и её время'],
    [`<line x1="-11" y1="3" x2="11" y2="-3" stroke="${glyphColor}" stroke-width="1.8" stroke-dasharray="5 4"/>`, 'выстрел убийцы'],
    [
      `<circle cy="-1" r="7" fill="${glyphColor}" stroke="#15181c" stroke-width="1.4"/>` +
        `<circle cx="-2.6" cy="-1.6" r="1.8" fill="#15181c"/><circle cx="2.6" cy="-1.6" r="1.8" fill="#15181c"/>` +
        `<rect x="-3.4" y="4.4" width="6.8" height="3.6" rx="1.4" fill="${glyphColor}" stroke="#15181c" stroke-width="1"/>`,
      'гибель (цвет — чей)',
    ],
    [causeBadge(0, 0, { icon: 'tank' }, '#8a919e').replace(/^<g transform="translate\(0 0\)">/, '<g>'), 'чем убит'],
    [`<circle r="6.5" fill="${glyphColor}" stroke="#10130d" stroke-width="1.8"/>`, 'жив в конце боя'],
  ]
  const symRows = Math.ceil(symbols.length / 2)
  const symH = 40 + symRows * 34
  const symY = H - 30 - symH
  if (py <= symY - 4) {
    parts.push(
      `<line x1="${PX}" y1="${symY}" x2="${PR}" y2="${symY}" stroke="#2a2e35" stroke-width="1.5"/>`,
      `<text x="${PX}" y="${symY + 30}" font-family="${FONTS}" font-size="19" font-weight="600" fill="#cfd4dc">Обозначения</text>`,
    )
    const colW = (PANEL_W - 60) / 2
    symbols.forEach(([glyph, text], i) => {
      const gx = PX + (i % 2) * colW + 12
      const gy = symY + 58 + Math.floor(i / 2) * 34
      parts.push(
        `<g transform="translate(${gx} ${gy})">${glyph}</g>`,
        `<text x="${gx + 24}" y="${gy + 6}" font-family="${FONTS}" font-size="16.5" fill="#9aa2b1">${text}</text>`,
      )
    })
  }

  parts.push('</svg>')
  return parts.join('\n')
}

// ---------- утилиты ----------

const r1 = (v: number): string => (Math.round(v * 10) / 10).toString()

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function trimTo(s: string, n: number): string {
  return [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s
}

/** мс от начала боя → «м:сс» */
const fmtTime = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

interface TeamSpawn {
  x: number
  z: number
  label: string
}

/** Медианный начальный спавн команды и его направление относительно центра карты. */
function teamSpawn(players: PlayerPaths[], cx: number, cz: number, half: number): TeamSpawn | null {
  const starts = players.flatMap((player) => {
    const first = player.paths
      .map((unit) => unit.path[0])
      .filter((point): point is SpaceTime => point !== undefined)
      .sort((a, b) => a.t - b.t)[0]
    return first ? [first] : []
  })
  if (starts.length === 0) return null

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  }
  const x = median(starts.map((point) => point.x))
  const z = median(starts.map((point) => point.z))
  const dx = (x - cx) / half
  const dz = (z - cz) / half
  if (Math.hypot(dx, dz) < 0.12) return { x, z, label: 'спавн в центре' }

  const sector = Math.round(Math.atan2(dz, dx) / (Math.PI / 4))
  const direction =
    sector === 0
      ? 'справа'
      : sector === 1
        ? 'сверху справа'
        : sector === 2
          ? 'сверху'
          : sector === 3
            ? 'сверху слева'
            : Math.abs(sector) === 4
              ? 'слева'
              : sector === -3
                ? 'снизу слева'
                : sector === -2
                  ? 'снизу'
                  : 'снизу справа'
  return { x, z, label: `спавн ${direction}` }
}

/** Шаг меток времени в минутах: не больше ~6 меток на траекторию */
function tickStepMinutes(durationMs: number): number {
  const minutes = durationMs / 60000
  return [2, 3, 5, 10, 15].find((s) => minutes / s <= 6) ?? 20
}

/**
 * Точки меток времени вдоль пути: раз в stepMs, позиция интерполируется
 * между соседними точками; разрывы (телепорт/пауза, как в splitSegments)
 * пропускаются.
 */
function timeTicks(path: SpaceTime[], stepMs: number): { x: number; z: number; minute: number }[] {
  const out: { x: number; z: number; minute: number }[] = []
  const start = path[0]!.t
  const end = path[path.length - 1]!.t
  let i = 0
  for (let t = Math.ceil(start / stepMs) * stepMs; t <= end; t += stepMs) {
    while (i + 1 < path.length && path[i + 1]!.t < t) i++
    const a = path[i]!
    const b = path[i + 1]
    if (!b) break
    if (b.t - a.t > 60000 || Math.hypot(b.x - a.x, b.z - a.z) > 400) continue
    const k = (t - a.t) / (b.t - a.t || 1)
    out.push({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, minute: Math.round(t / 60000) })
  }
  return out
}

/**
 * Точка пути игрока в момент t (лерп между соседними записями): пауза
 * записи у стоящего юнита интерполируется корректно, телепорт (>400 м
 * между записями) — нет. null — момент вне путей или разрыв.
 */
function pointAtTime(paths: ReplayUnitPath[], t: number): SpaceTime | null {
  for (const u of paths) {
    const path = u.path
    if (t < path[0]!.t || t > path[path.length - 1]!.t) continue
    let i = 0
    while (i + 1 < path.length && path[i + 1]!.t < t) i++
    const a = path[i]!
    const b = path[i + 1] ?? a
    if (Math.hypot(b.x - a.x, b.z - a.z) > 400) return null
    const k = (t - a.t) / (b.t - a.t || 1)
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }
  }
  return null
}

/** Ближайшая по времени точка путей игрока */
function nearestPoint(paths: ReplayUnitPath[], t: number): SpaceTime | null {
  let best: SpaceTime | null = null
  let bestDt = Infinity
  for (const u of paths) {
    for (const p of u.path) {
      const dt = Math.abs(p.t - t)
      if (dt < bestDt) {
        bestDt = dt
        best = p
      }
    }
  }
  return bestDt < 60000 ? best : null
}

/** Авиация: путь после гибели — падающий остов, обрезаем по событию */
function truncateAtDeath(unit: ReplayUnitPath, events: ReplayEvents, userId: string): ReplayUnitPath {
  const start = unit.path[0]!.t
  const end = unit.path[unit.path.length - 1]!.t
  const death = events.kills.find((k) => k.victimId === userId && k.time >= start && k.time <= end)
  if (!death) return unit
  return { ...unit, path: unit.path.filter((p) => p.t <= death.time + 4000) }
}

/** Квадратные границы по точкам (+ опциональная стартовая область) */
function fitBounds(
  points: SpaceTime[],
  seed: { x0: number; z0: number; x1: number; z1: number } | null,
): { x0: number; z0: number; x1: number; z1: number } {
  let x0 = seed?.x0 ?? Infinity
  let z0 = seed?.z0 ?? Infinity
  let x1 = seed?.x1 ?? -Infinity
  let z1 = seed?.z1 ?? -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.z < z0) z0 = p.z
    if (p.z > z1) z1 = p.z
  }
  if (!Number.isFinite(x0)) {
    x0 = -1000
    z0 = -1000
    x1 = 1000
    z1 = 1000
  }
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const half = (Math.max(x1 - x0, z1 - z0) / 2 || 1000) * 1.06
  return { x0: cx - half, z0: cz - half, x1: cx + half, z1: cz + half }
}

/** Разрыв траектории на телепорте (респаун) или большой паузе */
function splitSegments(path: SpaceTime[]): SpaceTime[][] {
  const segments: SpaceTime[][] = []
  let cur: SpaceTime[] = []
  let prev: SpaceTime | null = null
  for (const p of path) {
    if (prev && (Math.hypot(p.x - prev.x, p.z - prev.z) > 400 || p.t - prev.t > 60000)) {
      if (cur.length >= 2) segments.push(cur)
      cur = []
    }
    cur.push(p)
    prev = p
  }
  if (cur.length >= 2) segments.push(cur)
  return segments
}

/** Позиция из события смерти годится, если она недалеко от конца пути */
function isNear(pos: SpaceTime, near: SpaceTime, radius = 600): boolean {
  return Math.hypot(pos.x - near.x, pos.z - near.z) < radius
}

function mostCommonTag(tags: string[]): string | null {
  const counts = new Map<string, number>()
  for (const t of tags) {
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/** Стоянки: максимальные интервалы, где юнит не отходил от точки-якоря
 * дальше radius; длинный пропуск в записи при той же позиции — тоже
 * стоянка (GMSync может не слать точки неподвижного юнита) */
function findCamps(
  path: SpaceTime[],
  minMs = 60000,
  radius = 30,
): { x: number; z: number; durMs: number }[] {
  const out: { x: number; z: number; durMs: number }[] = []
  let i = 0
  while (i < path.length - 1) {
    const anchor = path[i]!
    let j = i
    while (j + 1 < path.length && Math.hypot(path[j + 1]!.x - anchor.x, path[j + 1]!.z - anchor.z) <= radius) {
      j++
    }
    const durMs = path[j]!.t - anchor.t
    if (durMs >= minMs) {
      let sx = 0
      let sz = 0
      for (let k = i; k <= j; k++) {
        sx += path[k]!.x
        sz += path[k]!.z
      }
      out.push({ x: sx / (j - i + 1), z: sz / (j - i + 1), durMs })
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

/** Череп в цвете погибшего */
function skullIcon(x: number, y: number, color: string): string {
  return (
    `<g transform="translate(${r1(x - 17)} ${r1(y - 17)}) scale(1.45)">` +
    `<circle cx="12" cy="11.5" r="11" fill="#15181c" fill-opacity="0.55"/>` +
    `<circle cx="12" cy="10" r="8.2" fill="${color}" stroke="#15181c" stroke-width="1.6"/>` +
    `<rect x="8" y="14.5" width="8" height="7" rx="2" fill="${color}" stroke="#15181c" stroke-width="1.2"/>` +
    `<circle cx="9" cy="10" r="2.1" fill="#15181c"/>` +
    `<circle cx="15" cy="10" r="2.1" fill="#15181c"/>` +
    `<rect x="10.4" y="16.5" width="1.4" height="3.5" fill="#15181c"/>` +
    `<rect x="13" y="16.5" width="1.4" height="3.5" fill="#15181c"/>` +
    `</g>`
  )
}

// ---------- причина смерти ----------

type DeathCause = { icon: 'tank' | 'plane' | 'heli' | 'aa' | 'crash' } | { label: string }

/** ЗУР зениток: отдельных файлов в датамайне нет, различаем по имени */
const SAM_RE =
  /zur|9m3\d|fim_?92|mim_?72|mim_?146|roland|rapier|type_?81|type_?91|starstreak|igla|stinger|aspide|crotale|santal|adats|vt1/i

/**
 * Чем убит: для авиации — тип ГСН ракеты (ИК/ПАРЛ/АРЛ из датамайна,
 * ЗУР по имени оружия зенитки), иначе — силуэт класса убийцы.
 * Без убийцы — «разбился». null — причину не определить.
 */
function deathCause(
  k: ReplayKill,
  mode: 'ground' | 'air',
  dict: VehicleDict,
  seekers: Map<string, MissileSeeker> | undefined,
): DeathCause | null {
  if (!k.killerId || k.killerId === k.victimId) return { icon: 'crash' }
  const killerCls = vehicleInfo(dict, modelId(k.killerModel)).cls
  if (mode === 'air') {
    const seeker = seekers?.get(k.weapon)
    if (seeker === 'ir') return { label: 'ИК' }
    if (seeker === 'sarh') return { label: 'ПАРЛ' }
    if (seeker === 'arh') return { label: 'АРЛ' }
    if (killerCls === 'AA' && SAM_RE.test(k.weapon)) return { label: 'ЗУР' }
  }
  switch (killerCls) {
    case 'T':
    case 'L':
      return { icon: 'tank' }
    case 'F':
      return { icon: 'plane' }
    case 'H':
      return { icon: 'heli' }
    case 'AA':
      return { icon: 'aa' }
    default:
      return null
  }
}

/** Белые силуэты значков причины смерти (в координатах ±10) */
const CAUSE_ICONS: Record<string, string> = {
  tank:
    `<rect x="-8.5" y="0.5" width="17" height="5.5" rx="2.6"/>` +
    `<rect x="-4.5" y="-4.8" width="7.5" height="4.4" rx="1.2"/>` +
    `<rect x="2.6" y="-3.8" width="7.6" height="1.8" rx="0.9"/>`,
  plane:
    `<path d="M0 -9.5 L2.3 -2.8 L9.5 2.6 L2.2 1.3 L1.7 6.2 L4.3 8.8 L-4.3 8.8 L-1.7 6.2 L-2.2 1.3 L-9.5 2.6 L-2.3 -2.8 Z"/>`,
  heli:
    `<rect x="-9" y="-5" width="18" height="2" rx="1"/>` +
    `<rect x="-1" y="-3.6" width="2" height="3"/>` +
    `<ellipse cx="-1.4" cy="2.2" rx="6" ry="3.8"/>` +
    `<rect x="3.4" y="1" width="6.6" height="1.8" rx="0.9"/>` +
    `<rect x="7.6" y="-1.6" width="1.8" height="3.4" rx="0.9"/>`,
  aa:
    `<rect x="-1.1" y="-10" width="2.2" height="9.5" rx="1" transform="rotate(38)"/>` +
    `<rect x="-1.1" y="-10" width="2.2" height="9.5" rx="1" transform="rotate(22)"/>` +
    `<circle cy="2.4" r="3.4"/>` +
    `<rect x="-7" y="3.6" width="14" height="3.4" rx="1.6"/>`,
  crash:
    `<path d="M0 -10 L2.4 -3.4 L8.4 -6.2 L4.2 -0.8 L10 1.8 L3.4 2.6 L4.8 9.4 L0 4.4 L-4.8 9.4 L-3.4 2.6 L-10 1.8 L-4.2 -0.8 L-8.4 -6.2 L-2.4 -3.4 Z"/>`,
}

/** Подпись техники убийцы под черепом — когда его нет на этой карте */
function killerLabel(x: number, y: number, text: string): string {
  const t = esc(text)
  const attrs = `x="${r1(x)}" y="${r1(y)}" font-family="${FONTS}" font-size="13.5" font-weight="700" text-anchor="middle"`
  return (
    `<text ${attrs} fill="none" stroke="#10130d" stroke-width="3.2">${t}</text>` +
    `<text ${attrs} fill="#e8ebf0">${t}</text>`
  )
}

/** Значок причины смерти у черепа; ободок — цвет убийцы */
function causeBadge(x: number, y: number, cause: DeathCause, ring: string): string {
  if ('icon' in cause) {
    return (
      `<g transform="translate(${r1(x)} ${r1(y)})">` +
      `<circle r="10.5" fill="#10130d" fill-opacity="0.88" stroke="${ring}" stroke-width="1.8"/>` +
      `<g transform="scale(0.72)" fill="#f2f4f7">${CAUSE_ICONS[cause.icon]}</g>` +
      `</g>`
    )
  }
  const w = 12 + cause.label.length * 7.2
  return (
    `<g transform="translate(${r1(x)} ${r1(y)})">` +
    `<rect x="${r1(-w / 2)}" y="-9" width="${r1(w)}" height="18" rx="8.5" fill="#10130d" fill-opacity="0.88" stroke="${ring}" stroke-width="1.8"/>` +
    `<text y="4" font-family="${FONTS}" font-size="11" font-weight="700" fill="#f2f4f7" text-anchor="middle">${cause.label}</text>` +
    `</g>`
  )
}
