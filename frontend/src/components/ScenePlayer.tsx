import { useEffect, useMemo, useRef, useState } from 'react'
import { battleMapUrl, type BattleScene, type SceneUnit, type VehicleDict } from '../api'
import { t, useLocale } from '../i18n'
import { fmtInt } from '../lib/format'

// Интерактивная «карта-видео»: Canvas 2D поверх тактической карты (или сетки).
// React управляет только обвязкой; сам кадр рисуется в requestAnimationFrame
// из мутируемого стейта (время/фильтры в ref), чтобы держать 60 fps.

const TEAM_COLORS = ['#5f80f2', '#d0731f'] as const
const TEAM_BRIGHT = ['#7f9bff', '#f2984a'] as const
const NEUTRAL_COLOR = '#7d7885'
const TRAIL_MS = 45_000
const KILL_FLASH_MS = 2_500
/** Юнит скрывается спустя несколько секунд после конца траектории (смерть/выход). */
const LINGER_MS = 5_000
const SPEEDS = [1, 4, 16] as const
/** Событие подсвечивается в ленте это время после наступления. */
const FEED_RECENT_MS = 40_000

interface PlayerState {
  timeMs: number
  playing: boolean
  speed: number
  showTeams: [boolean, boolean]
  showAir: boolean
  showTraj: boolean
  showKills: boolean
  showZones: boolean
  focusUserId: string | null
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Позиция юнита в момент t: линейная интерполяция соседних точек пути. */
function unitPosition(unit: SceneUnit, t: number): [number, number] | null {
  const path = unit.path
  if (path.length === 0) return null
  const first = path[0]!
  const last = path[path.length - 1]!
  if (t < first[0]) return null
  if (t > last[0] + LINGER_MS) return null
  if (t >= last[0]) return [last[1], last[2]]
  let lo = 0
  let hi = path.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (path[mid]![0] <= t) lo = mid
    else hi = mid
  }
  const a = path[lo]!
  const b = path[hi]!
  const span = b[0] - a[0]
  const k = span > 0 ? (t - a[0]) / span : 0
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

export function ScenePlayer({ scene, dict, battleKey }: {
  scene: BattleScene
  dict: VehicleDict
  battleKey: string
}) {
  const { locale } = useLocale()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<PlayerState>({
    timeMs: 0,
    playing: false,
    speed: 4,
    showTeams: [true, true],
    showAir: true,
    showTraj: true,
    showKills: true,
    showZones: true,
    focusUserId: null,
  })
  // Зеркало для UI: обновляется таймером, а не каждым кадром.
  const [uiTime, setUiTime] = useState(0)
  const [uiPlaying, setUiPlaying] = useState(false)
  const [uiSpeed, setUiSpeed] = useState(4)
  const [showTeams, setShowTeams] = useState<[boolean, boolean]>([true, true])
  const [showAir, setShowAir] = useState(true)
  const [showTraj, setShowTraj] = useState(true)
  const [showKills, setShowKills] = useState(true)
  const [showZones, setShowZones] = useState(true)
  const [focusUserId, setFocusUserId] = useState<string | null>(null)
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null)

  const teamByUser = useMemo(() => {
    const map = new Map<string, number>()
    for (const player of scene.players) map.set(player.userId, player.team)
    return map
  }, [scene])

  const nickByUser = useMemo(() => {
    const map = new Map<string, string>()
    for (const player of scene.players) map.set(player.userId, player.nick)
    return map
  }, [scene])

  useEffect(() => {
    stateRef.current.showTeams = showTeams
    stateRef.current.showAir = showAir
    stateRef.current.showTraj = showTraj
    stateRef.current.showKills = showKills
    stateRef.current.showZones = showZones
    stateRef.current.focusUserId = focusUserId
  }, [showTeams, showAir, showTraj, showKills, showZones, focusUserId])

  useEffect(() => {
    if (!scene.map.available) return
    const image = new Image()
    image.onload = () => setMapImage(image)
    image.src = battleMapUrl(battleKey)
    return () => { image.onload = null }
  }, [scene, battleKey])

  // Основной цикл отрисовки.
  useEffect(() => {
    const canvas = canvasRef.current
    const box = boxRef.current
    if (!canvas || !box) return
    const context = canvas.getContext('2d')
    if (!context) return

    const [x0, z0, x1, z1] = scene.worldBounds
    const worldW = Math.max(1, x1 - x0)
    const worldH = Math.max(1, z1 - z0)

    let raf = 0
    let lastFrameAt = performance.now()
    let disposed = false

    const draw = (now: number): void => {
      if (disposed) return
      const state = stateRef.current
      const dt = now - lastFrameAt
      lastFrameAt = now
      if (state.playing) {
        state.timeMs = Math.min(scene.endTimeMs, state.timeMs + dt * state.speed)
        if (state.timeMs >= scene.endTimeMs) state.playing = false
      }
      const t = state.timeMs

      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cssW = box.clientWidth
      const cssH = Math.max(320, Math.min(640, Math.round(cssW * (worldH / worldW))))
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
        canvas.style.height = `${cssH}px`
      }
      const W = canvas.width
      const H = canvas.height

      const scale = Math.min(W / worldW, H / worldH)
      const ox = (W - worldW * scale) / 2
      const oy = (H - worldH * scale) / 2
      const wx = (x: number): number => ox + (x - x0) * scale
      const wz = (z: number): number => oy + (z1 - z) * scale

      context.clearRect(0, 0, W, H)
      context.fillStyle = '#0f0e13'
      context.fillRect(0, 0, W, H)

      if (mapImage) {
        context.globalAlpha = 0.85
        context.drawImage(mapImage, wx(x0), wz(z1), worldW * scale, worldH * scale)
        context.globalAlpha = 1
      } else {
        // Сетка каждые 500 м — ориентир без картинки карты.
        context.strokeStyle = '#26232c'
        context.lineWidth = 1
        for (let gx = Math.ceil(x0 / 500) * 500; gx <= x1; gx += 500) {
          context.beginPath()
          context.moveTo(wx(gx), wz(z0))
          context.lineTo(wx(gx), wz(z1))
          context.stroke()
        }
        for (let gz = Math.ceil(z0 / 500) * 500; gz <= z1; gz += 500) {
          context.beginPath()
          context.moveTo(wx(x0), wz(gz))
          context.lineTo(wx(x1), wz(gz))
          context.stroke()
        }
      }

      // Зоны захвата.
      if (state.showZones) {
        for (const zone of scene.zones) {
          const zx = wx(zone.x)
          const zy = wz(zone.z)
          context.beginPath()
          context.arc(zx, zy, 11 * dpr, 0, Math.PI * 2)
          context.strokeStyle = 'rgba(184, 179, 172, 0.8)'
          context.setLineDash([5 * dpr, 4 * dpr])
          context.lineWidth = 1.5 * dpr
          context.stroke()
          context.setLineDash([])
          context.fillStyle = 'rgba(242, 239, 230, 0.9)'
          context.font = `${10 * dpr}px "Segoe UI", system-ui, sans-serif`
          context.textAlign = 'center'
          context.textBaseline = 'middle'
          context.fillText(zone.name.slice(0, 1).toUpperCase(), zx, zy)
        }
      }

      for (const unit of scene.units) {
        if (!state.showAir && unit.source === 'air') continue
        const team = unit.userId !== null ? teamByUser.get(unit.userId) : undefined
        if (team === 1 && !state.showTeams[0]) continue
        if (team === 2 && !state.showTeams[1]) continue
        const position = unitPosition(unit, t)
        if (!position) continue
        const focused = state.focusUserId !== null && unit.userId === state.focusUserId
        const dimmed = state.focusUserId !== null && !focused
        const color = team === 1 ? TEAM_COLORS[0] : team === 2 ? TEAM_COLORS[1] : NEUTRAL_COLOR

        // Хвост траектории за последние TRAIL_MS.
        if (state.showTraj) {
          context.beginPath()
          let started = false
          for (const point of unit.path) {
            if (point[0] < t - TRAIL_MS) continue
            if (point[0] > t) break
            const px = wx(point[1])
            const py = wz(point[2])
            if (started) context.lineTo(px, py)
            else { context.moveTo(px, py); started = true }
          }
          if (started) {
            context.lineTo(wx(position[0]), wz(position[1]))
            context.strokeStyle = color
            context.globalAlpha = dimmed ? 0.12 : unit.source === 'air' ? 0.5 : 0.65
            context.lineWidth = (focused ? 2.4 : 1.4) * dpr
            if (unit.source === 'air') context.setLineDash([4 * dpr, 3 * dpr])
            context.stroke()
            context.setLineDash([])
            context.globalAlpha = 1
          }
        }

        // Сам юнит.
        const ux = wx(position[0])
        const uy = wz(position[1])
        context.beginPath()
        context.arc(ux, uy, (focused ? 5.5 : unit.source === 'air' ? 3 : 4) * dpr, 0, Math.PI * 2)
        context.fillStyle = color
        context.globalAlpha = dimmed ? 0.25 : 1
        context.fill()
        if (focused) {
          context.strokeStyle = '#f2efe6'
          context.lineWidth = 1.5 * dpr
          context.stroke()
        }
        if ((focused || scale * worldW > 700) && unit.userId && !dimmed) {
          const nick = nickByUser.get(unit.userId)
          if (nick) {
            context.fillStyle = 'rgba(242, 239, 230, 0.9)'
            context.font = `${9 * dpr}px "Segoe UI", system-ui, sans-serif`
            context.textAlign = 'left'
            context.textBaseline = 'bottom'
            context.fillText(nick, ux + 6 * dpr, uy - 4 * dpr)
          }
        }
        context.globalAlpha = 1
      }

      // Маркеры килов: вспышка вокруг момента события.
      if (state.showKills) {
        for (const kill of scene.kills) {
          if (kill.x === null || kill.z === null) continue
          const age = t - kill.t
          if (age < 0 || age > KILL_FLASH_MS) continue
          const kx = wx(kill.x)
          const ky = wz(kill.z)
          const alpha = 1 - age / KILL_FLASH_MS
          const radius = (4 + (age / KILL_FLASH_MS) * 10) * dpr
          context.globalAlpha = alpha
          context.strokeStyle = '#ff8fa3'
          context.lineWidth = 1.6 * dpr
          context.beginPath()
          context.moveTo(kx - radius, ky - radius)
          context.lineTo(kx + radius, ky + radius)
          context.moveTo(kx + radius, ky - radius)
          context.lineTo(kx - radius, ky + radius)
          context.stroke()
          context.globalAlpha = 1
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
    }
  }, [scene, mapImage, teamByUser, nickByUser])

  // Синхронизация UI-зеркала времени (10 раз в секунду достаточно).
  useEffect(() => {
    const timer = window.setInterval(() => {
      setUiTime(stateRef.current.timeMs)
      setUiPlaying(stateRef.current.playing)
    }, 100)
    return () => window.clearInterval(timer)
  }, [])

  // Лента событий: килы + финал боя, синхронно с картой.
  const feed = useMemo(() => {
    const entries = scene.kills
      .filter((kill) => kill.killerId !== null || kill.victimId !== null)
      .slice(0, 200)
      .map((kill, index) => ({
        key: `k${index}`,
        t: kill.t,
        dot: '#ff8fa3',
        text: t('scene.feed.kill', {
          killer: kill.killerId ? nickByUser.get(kill.killerId) ?? t('scene.feed.ai') : t('scene.feed.ai'),
          victim: kill.victimId ? nickByUser.get(kill.victimId) ?? t('scene.feed.ai') : t('scene.feed.ai'),
        }),
        extra: dict[kill.weapon]?.name ?? kill.weapon,
      }))
    if (scene.teamWon !== 0) {
      entries.push({
        key: 'end',
        t: scene.endTimeMs,
        dot: 'var(--ok)',
        text: t('scene.feed.finale', { n: scene.teamWon }),
        extra: '',
      })
    }
    return entries.sort((a, b) => a.t - b.t)
  }, [scene, nickByUser, dict, locale])

  const seek = (ms: number): void => {
    stateRef.current.timeMs = Math.max(0, Math.min(scene.endTimeMs, ms))
    stateRef.current.playing = false
    setUiTime(stateRef.current.timeMs)
    setUiPlaying(false)
  }

  const rosterChip = (player: BattleScene['players'][number]) => {
    const focused = focusUserId === player.userId
    const dimmedByFocus = focusUserId !== null && !focused
    return (
      <button
        key={player.userId}
        type="button"
        className="roster-chip"
        style={{
          ...(focused ? { borderColor: 'var(--accent)', color: 'var(--ink)' } : {}),
          ...(dimmedByFocus ? { opacity: 0.55 } : {}),
        }}
        onClick={() => setFocusUserId(focused ? null : player.userId)}
        title={focused ? t('scene.focus.clear') : t('scene.focus.set', { nick: player.nick })}
      >
        <span
          style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: player.team === 1 ? TEAM_BRIGHT[0] : player.team === 2 ? TEAM_BRIGHT[1] : NEUTRAL_COLOR,
          }}
        />
        {player.nick}
      </button>
    )
  }

  return (
    <div className="scene-grid">
      <div className="scene-main">
        {scene.players.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
            {scene.players.filter((player) => player.team === 1).map(rosterChip)}
            <span style={{ flex: 1 }} />
            {scene.players.filter((player) => player.team !== 1).map(rosterChip)}
            {focusUserId !== null && (
              <button type="button" className="roster-chip" onClick={() => setFocusUserId(null)}>{t('scene.focus.reset')}</button>
            )}
          </div>
        )}

        <div ref={boxRef} style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line2)', background: '#0f0e13' }}>
          <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            className="btn gold"
            type="button"
            onClick={() => {
              if (!uiPlaying && stateRef.current.timeMs >= scene.endTimeMs) stateRef.current.timeMs = 0
              stateRef.current.playing = !stateRef.current.playing
              setUiPlaying(stateRef.current.playing)
            }}
          >
            {uiPlaying ? t('scene.pause') : t('scene.play')}
          </button>
          <div className="seg-control" role="group" aria-label={t('scene.speed.aria')}>
            {SPEEDS.map((option) => (
              <button
                key={option}
                className={uiSpeed === option ? 'active' : ''}
                type="button"
                onClick={() => {
                  stateRef.current.speed = option
                  setUiSpeed(option)
                }}
              >
                {option}×
              </button>
            ))}
          </div>
          <span className="muted small" style={{ fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>
            {formatClock(uiTime)} / {formatClock(scene.endTimeMs)}
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={scene.endTimeMs}
          value={Math.round(uiTime)}
          onChange={(event) => seek(Number(event.target.value))}
          style={{ width: '100%', marginTop: 8, cursor: 'pointer' }}
          aria-label={t('scene.timeline.aria')}
        />
        {/* Метки событий на таймлайне: клик — прыжок к моменту. */}
        {feed.length > 0 && scene.endTimeMs > 0 && (
          <div style={{ position: 'relative', height: 8, margin: '2px 6px 0' }}>
            {feed.map((entry) => (
              <span
                key={entry.key}
                onClick={() => seek(entry.t)}
                title={`${formatClock(entry.t)} · ${entry.text}`}
                style={{
                  position: 'absolute',
                  left: `${((entry.t / scene.endTimeMs) * 100).toFixed(1)}%`,
                  top: 0, width: 4, height: 8, borderRadius: 2,
                  background: entry.dot, cursor: 'pointer', transform: 'translateX(-2px)',
                }}
              />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }} className="small">
          <label style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showTraj} onChange={(event) => setShowTraj(event.target.checked)} />{' '}
            {t('scene.toggle.traj')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showKills} onChange={(event) => setShowKills(event.target.checked)} />{' '}
            {t('scene.toggle.kills')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showZones} onChange={(event) => setShowZones(event.target.checked)} />{' '}
            {t('scene.toggle.zones')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showTeams[0]}
              onChange={(event) => setShowTeams([event.target.checked, showTeams[1]])}
            />{' '}
            <span className="swatch" style={{ background: TEAM_COLORS[0] }} />{t('scene.toggle.team1')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showTeams[1]}
              onChange={(event) => setShowTeams([showTeams[0], event.target.checked])}
            />{' '}
            <span className="swatch" style={{ background: TEAM_COLORS[1] }} />{t('scene.toggle.team2')}
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showAir} onChange={(event) => setShowAir(event.target.checked)} />{' '}
            {t('scene.toggle.air')}
          </label>
          {!scene.map.available && <span className="muted">{t('scene.mapMissing')}</span>}
        </div>

        {scene.units.length === 0 && (
          <div className="notice">
            {t('scene.noUnits')}
          </div>
        )}
      </div>

      <aside className="scene-feed">
        <div className="sec-head" style={{ marginBottom: 8 }}>
          <h3>{t('scene.feed')}</h3>
          <span className="hint">{t('scene.feed.hint')}</span>
        </div>
        {feed.length === 0 ? (
          <div className="muted small">{t('scene.feed.empty')}</div>
        ) : (
          <div className="scene-feed-list">
            {feed.map((entry) => {
              const happened = uiTime >= entry.t
              const recent = happened && uiTime - entry.t < FEED_RECENT_MS
              return (
                <div
                  key={entry.key}
                  className="scene-feed-row"
                  style={{ opacity: happened ? 1 : 0.38, ...(recent ? { background: 'var(--bg-soft)' } : {}) }}
                  onClick={() => seek(entry.t)}
                  title={t('scene.feed.jump')}
                >
                  <span className="muted" style={{ flex: 'none', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: 34, paddingTop: 1 }}>
                    {formatClock(entry.t)}
                  </span>
                  <span style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', marginTop: 4, background: entry.dot }} />
                  <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                    {entry.text}
                    {entry.extra && <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}> · {entry.extra}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        <div className="muted small" style={{ marginTop: 8 }}>{t('scene.kills.total', { n: fmtInt(scene.kills.length) })}</div>
      </aside>
    </div>
  )
}
