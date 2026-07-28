// Локальный предпросмотр сайта на демо-фикстурах: SQLite :memory: + Fastify,
// без Discord, парсеров и внешних сервисов. Для вёрстки и ручной проверки SPA.
// Запуск: npx tsx src/analysis/site-preview.ts  → http://127.0.0.1:3210/app
import { rm } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import {
  closeDb,
  initDb,
  saveBattle,
  saveClanRatingSnapshots,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
  upsertClans,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { buildServer } from '../web/index.js'

const PORT = 3210
const CLAN = '═AURI║'
const ENEMY_CLAN = '=WOLF='
const NOW = Math.floor(Date.now() / 1_000)
const DAY = 86_400

function player(
  userId: string,
  nick: string,
  team: number,
  vehicleId: string,
  overrides: Partial<BattlePlayerInput> = {},
): BattlePlayerInput {
  return {
    userId,
    nick,
    clanTag: '',
    team,
    kills: Math.floor(Math.random() * 3),
    groundKills: Math.floor(Math.random() * 6),
    navalKills: 0,
    aiKills: Math.floor(Math.random() * 2),
    aiGroundKills: Math.floor(Math.random() * 4),
    assists: Math.floor(Math.random() * 3),
    deaths: 1 + Math.floor(Math.random() * 3),
    captureZone: Math.floor(Math.random() * 3),
    damageZone: 0,
    score: 300 + Math.floor(Math.random() * 1_500),
    awardDamage: 0,
    teamKills: 0,
    squadId: -1,
    vehicle: vehicleId,
    vehicles: [vehicleId],
    disconnected: false,
    slot: null,
    title: null,
    autoSquad: null,
    ...overrides,
  }
}

function battle(
  sessionId: string,
  startTime: number,
  teamWon: number,
  mission: string,
  players: BattlePlayerInput[],
  eventsBlob: Buffer = Buffer.alloc(0),
): BattleInput {
  return {
    sessionId,
    sessionHex: BigInt(sessionId).toString(16).padStart(16, '0'),
    missionName: mission,
    level: 'levels/avg_test.bin',
    gameMode: 'ground',
    battleType: 'random',
    environment: null,
    status: 'left',
    startTime,
    durationSec: 900 + Math.floor(Math.random() * 900),
    endTimeMs: (startTime + 1_200) * 1_000,
    teamWon,
    gameVersion: '2.49.0.60',
    missionSettings: null,
    players,
    kills: [],
    chat: [],
    eventsBlob,
  }
}

/** Синтетические траектории: дуги от спавнов команд к центру + килы. */
function demoEvents(all: BattlePlayerInput[], seed: number): Buffer {
  const durationMs = 15 * 60_000
  const units = all.map((entry, index) => {
    const team = entry.team
    const angle0 = (index / all.length) * Math.PI * 2 + seed * 0.7
    const spawnX = team === 1 ? -1_600 : 1_600
    const spawnZ = (index % 4 - 1.5) * 700
    const path = Array.from({ length: 240 }, (_unused, step) => {
      const t = (step / 239) * durationMs
      const progress = Math.min(1, step / 160)
      const wobble = Math.sin(step / 12 + angle0) * 180
      return {
        t,
        x: spawnX * (1 - progress * 0.85) + wobble,
        y: 10,
        z: spawnZ * (1 - progress * 0.5) + Math.cos(step / 15 + angle0) * 240,
      }
    })
    return { userId: entry.userId, model: `tankModels/${entry.vehicle ?? 'tank'}`, source: 'ground' as const, path }
  })
  const kills = all.slice(0, 6).map((entry, index) => {
    const victim = all[(index + 4) % all.length]!
    const at = ((index + 1) / 7) * durationMs
    return {
      time: at,
      killerId: entry.userId,
      killerModel: `tankModels/${entry.vehicle ?? 'tank'}`,
      victimId: victim.userId,
      victimModel: `tankModels/${victim.vehicle ?? 'tank'}`,
      weapon: 'shell',
      killerPos: { x: (index - 2) * 300, y: 10, z: (index % 3 - 1) * 400 },
      victimPos: { x: (index - 2) * 300 + 120, y: 10, z: (index % 3 - 1) * 400 - 80 },
    }
  })
  const events = {
    teamWon: 0,
    players: [],
    damage: [],
    chat: [],
    kills,
    units,
    zones: [{ name: 'A', x: -900, z: 0 }, { name: 'B', x: 0, z: 200 }, { name: 'C', x: 900, z: -100 }],
    endTime: durationMs,
    errors: [],
  }
  return gzipSync(Buffer.from(JSON.stringify(events), 'utf8'))
}

function seed(): void {
  const members: { nick: string; userId: string; base: number }[] = [
    { nick: 'ViperAce', userId: '12345678', base: 1780 },
    { nick: 'NightHawk', userId: '23456789', base: 1655 },
    { nick: 'SteelRain', userId: '34567890', base: 1590 },
    { nick: 'Kestrel@psn', userId: '45678901', base: 1430 },
    { nick: 'BoarHunter', userId: '56789012', base: 1310 },
    { nick: 'Molniya', userId: '67890123', base: 1245 },
  ]

  upsertClans([
    { tag: CLAN, name: 'Aurora Imperialis' },
    { tag: ENEMY_CLAN, name: 'Wolfpack' },
  ])

  // История ПКР: несколько change-point снимков на участника.
  for (let step = 0; step < 8; step += 1) {
    saveClanRatingSnapshots(CLAN, members.map((member, index) => ({
      nick: member.nick,
      rating: member.base + Math.round(Math.sin(step / 2 + index) * 40) + step * 6,
    })))
  }
  saveClanRatingSnapshots(ENEMY_CLAN, [
    { nick: 'GrayWolf', rating: 1_505 },
    { nick: 'Fenrir', rating: 1_402 },
  ])

  // Identity + история statshark-снимков для первых трёх участников.
  for (const [index, member] of members.slice(0, 3).entries()) {
    const identity = savePlayerIdentity({
      wtUserId: member.userId,
      canonicalNick: member.nick,
      platform: member.nick.endsWith('@psn') ? 'psn' : null,
      aliases: [{
        source: 'wrpl',
        externalId: member.userId,
        nick: member.nick,
        seenAt: NOW - 90 * DAY,
        matchMethod: 'user_id',
        matchConfidence: 'high',
      }],
    })
    for (let snap = 0; snap < 7; snap += 1) {
      const battles = 11_800 + index * 900 + snap * 120
      const victories = Math.round(battles * (0.53 + index * 0.01 + snap * 0.002))
      savePlayerExternalSnapshot({
        identityId: identity.id,
        source: 'statshark',
        sourcePlayerId: member.userId,
        nick: member.nick,
        fetchedAt: NOW - (12 - snap) * 7 * DAY,
        sourceUpdatedAt: NOW - (12 - snap) * 7 * DAY,
        status: 'ok',
        rawJson: JSON.stringify({ demo: true, snap }),
        parserVersion: 'preview-v1',
        error: null,
        normalized: {
          totals: [
            {
              gameType: null, mode: null, category: null,
              battles, victories, defeats: battles - victories,
              deaths: Math.round(battles * 0.72), timePlayedSec: battles * 340,
              respawns: null, airKills: Math.round(battles * 0.25),
              groundKills: Math.round(battles * 0.8), navalKills: Math.round(battles * 0.02),
            },
            ...(['arcade', 'realistic', 'simulator'] as const).map((mode, modeIndex) => ({
              gameType: 'all' as string | null,
              mode: mode as string | null,
              category: 'pvp' as string | null,
              battles: Math.round(battles * [0.42, 0.52, 0.06][modeIndex]!),
              victories: Math.round(victories * [0.4, 0.54, 0.06][modeIndex]!),
              defeats: null,
              deaths: Math.round(battles * 0.7 * [0.42, 0.52, 0.06][modeIndex]!),
              timePlayedSec: Math.round(battles * 330 * [0.42, 0.52, 0.06][modeIndex]!),
              respawns: null,
              airKills: Math.round(battles * 0.24 * [0.42, 0.52, 0.06][modeIndex]!),
              groundKills: Math.round(battles * 0.78 * [0.42, 0.52, 0.06][modeIndex]!),
              navalKills: 0,
            })),
          ],
          vehicles: [
            ['ussr_t_80bvm', 1_240], ['ussr_2s38', 862], ['ussr_mig_29smt', 640],
            ['ussr_t_72b3_2016', 520], ['ussr_su_25k', 380], ['ussr_bmp_2m', 300],
          ].map(([vehicleId, flyouts], vehicleIndex) => ({
            gameType: 'tank',
            mode: 'realistic',
            vehicleId: vehicleId as string,
            flyouts: (flyouts as number) + snap * 10,
            victories: Math.round(((flyouts as number) + snap * 10) * (0.56 - vehicleIndex * 0.01)),
            defeats: null,
            deaths: Math.round((flyouts as number) * 0.65),
            airKills: vehicleIndex === 2 ? 700 : 12,
            groundKills: vehicleIndex === 2 ? 90 : Math.round((flyouts as number) * 1.6),
            navalKills: 0,
            timePlayedSec: null,
          })),
        },
      })
    }
  }

  // Бои за последние две недели: клан против волков.
  const vehicles = ['ussr_t_80bvm', 'ussr_2s38', 'ussr_mig_29smt', 'ussr_bmp_2m', 'ussr_t_72b3_2016', 'ussr_su_25k']
  for (let i = 0; i < 14; i += 1) {
    const won = i % 3 !== 0
    const sessionId = String(900_100_000 + i)
    const clanPlayers = members.slice(0, 4).map((member, index) =>
      player(member.userId, member.nick, 1, vehicles[index % vehicles.length]!, {
        clanTag: CLAN,
        score: 700 + Math.floor(Math.random() * 1_400),
      }))
    const enemies = ['GrayWolf', 'Fenrir', 'Lobo', 'Akela'].map((nick, index) =>
      player(String(88_000_000 + index), nick, 2, vehicles[(index + 2) % vehicles.length]!, {
        clanTag: index < 2 ? ENEMY_CLAN : '',
      }))
    const roster = [...clanPlayers, ...enemies]
    saveBattle(battle(
      sessionId,
      NOW - i * DAY + (i % 4) * 7_200 - 6 * 3_600,
      won ? 1 : 2,
      i % 2 === 0 ? 'Красная пустыня' : 'Прорыв линии Зигфрида',
      roster,
      demoEvents(roster, i),
    ))
  }
}

async function main(): Promise<void> {
  initDb(':memory:')
  seed()
  const app = buildServer(
    {
      getBotStatus: () => ({ online: true, tag: 'wtbot#demo', guilds: 1, uptimeSec: 3_600 }),
      refreshVoice: async () => ({ players: 0, clans: 0 }),
      playerStats: new PlayerStatsCoordinator({ externalService: null, externalSource: 'preview' }),
    },
    {
      loadVehicleDict: async () => ({
        ussr_t_80bvm: { name: 'Т-80БВМ', cls: 'T', country: 'ussr' },
        ussr_2s38: { name: '2С38', cls: 'AA', country: 'ussr' },
        ussr_mig_29smt: { name: 'МиГ-29СМТ', cls: 'F', country: 'ussr' },
        ussr_bmp_2m: { name: 'БМП-2М', cls: 'L', country: 'ussr' },
        ussr_t_72b3_2016: { name: 'Т-72Б3 (2016)', cls: 'T', country: 'ussr' },
        ussr_su_25k: { name: 'Су-25К', cls: 'F', country: 'ussr' },
      }),
    },
  )
  await app.listen({ host: '127.0.0.1', port: PORT })
  console.log(`[site-preview] Демо-сайт: http://127.0.0.1:${PORT}/app (Ctrl+C для выхода)`)
  const cleanupDemoScenes = async (): Promise<void> => {
    // Демо-сессии пишут scene-кэш в реальный data/battles — убираем свои файлы.
    for (let i = 0; i < 14; i += 1) {
      const hex = BigInt(String(900_100_000 + i)).toString(16).padStart(16, '0')
      await rm(`./data/battles/${hex}-scene-v1.json.gz`, { force: true }).catch(() => undefined)
    }
  }
  const shutdown = async () => {
    await cleanupDemoScenes()
    await app.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

await main()
