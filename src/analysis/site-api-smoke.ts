// Оффлайн-smoke read-модели сайта: SQLite :memory: + Fastify inject().
// Проверяет поиск, профили, историю, кланы, ленты боёв, скорборд, словарь
// техники, rate limit и read-only гарантию GET-профилей.
// Запуск: npm run verify:site-api
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  closeDb,
  getClanSeasonContext,
  initDb,
  saveBattle,
  saveClanLeaderboard,
  saveClanRatingSnapshots,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
  upsertClans,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { closeWorkerPool } from '../workers/pool.js'
import { buildServer } from '../web/index.js'
import { spaDistAvailable } from '../web/routes/spa.js'

const CLAN_RAW_TAG = '=TST='
const FORMULA_CLAN_RAW_TAG = '=FORM='

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
    kills: 1,
    groundKills: 2,
    navalKills: 0,
    aiKills: 0,
    aiGroundKills: 0,
    assists: 1,
    deaths: 1,
    captureZone: 0,
    damageZone: 0,
    score: 500,
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
  players: BattlePlayerInput[],
  eventsBlob: Buffer = Buffer.alloc(0),
): BattleInput {
  return {
    sessionId,
    sessionHex: BigInt(sessionId).toString(16).padStart(16, '0'),
    missionName: 'site-api-smoke',
    level: 'levels/test.bin',
    gameMode: 'ground',
    battleType: null,
    environment: null,
    status: null,
    startTime,
    durationSec: 600,
    endTimeMs: (startTime + 600) * 1_000,
    teamWon,
    gameVersion: null,
    missionSettings: null,
    players,
    kills: [],
    chat: [],
    eventsBlob,
  }
}

function aggregateTotals(battles: number, victories: number) {
  return {
    totals: [{
      gameType: null,
      mode: null,
      category: null,
      battles,
      victories,
      defeats: battles - victories,
      deaths: 40,
      timePlayedSec: 3_600,
      respawns: null,
      airKills: 10,
      groundKills: 30,
      navalKills: 0,
    }],
    vehicles: [{
      gameType: 'tank',
      mode: 'realistic',
      vehicleId: 'test_tank',
      flyouts: battles,
      victories,
      defeats: battles - victories,
      deaths: 20,
      airKills: 1,
      groundKills: 25,
      navalKills: 0,
      timePlayedSec: null,
    }],
  }
}

async function main(): Promise<void> {
  initDb(':memory:')
  const nowSec = Math.floor(Date.now() / 1_000)
  const seasonAtStart = getClanSeasonContext(Date.parse('2026-07-01T00:00:00Z') / 1_000)
  assert.equal(seasonAtStart.currentStage?.week, 1)
  assert.equal(seasonAtStart.currentStage?.maxBr, 14.7)
  const seasonAtFourthWeek = getClanSeasonContext(Date.parse('2026-07-22T12:00:00Z') / 1_000)
  assert.equal(seasonAtFourthWeek.currentStage?.week, 4)
  assert.equal(seasonAtFourthWeek.currentStage?.maxBr, 9.7)
  const seasonAtEnd = getClanSeasonContext(Date.parse('2026-09-01T00:00:00Z') / 1_000)
  assert.equal(seasonAtEnd.currentStage, null)
  assert.equal(seasonAtEnd.season?.active, false)

  // Identity + два внешних снимка statshark для истории.
  const identity = savePlayerIdentity({
    wtUserId: '501',
    canonicalNick: 'PilotOne',
    platform: null,
    aliases: [{
      source: 'wrpl',
      externalId: '501',
      nick: 'PilotOne',
      seenAt: nowSec - 10 * 86_400,
      matchMethod: 'user_id',
      matchConfidence: 'high',
    }],
  })
  savePlayerExternalSnapshot({
    identityId: identity.id,
    source: 'statshark',
    sourcePlayerId: '501',
    nick: 'PilotOne',
    fetchedAt: nowSec - 2 * 86_400,
    sourceUpdatedAt: nowSec - 2 * 86_400,
    status: 'ok',
    rawJson: '{"version":1}',
    parserVersion: 'site-smoke-v1',
    error: null,
    normalized: aggregateTotals(100, 55),
  })
  savePlayerExternalSnapshot({
    identityId: identity.id,
    source: 'statshark',
    sourcePlayerId: '501',
    nick: 'PilotOne',
    fetchedAt: nowSec - 86_400,
    sourceUpdatedAt: nowSec - 86_400,
    status: 'ok',
    rawJson: '{"version":2}',
    parserVersion: 'site-smoke-v1',
    error: null,
    normalized: aggregateTotals(110, 61),
  })

  // Клан: словарь имени + два обхода ПОЛНОГО ростера (контракт clan_roster).
  // Ghost есть только в первом обходе — покинул клан и должен исчезнуть из
  // ростера, сумм и истории; у PilotOne дельта +20.
  upsertClans([{ tag: CLAN_RAW_TAG, name: 'Test Clan' }])
  saveClanRatingSnapshots(CLAN_RAW_TAG, [
    { nick: 'PilotOne', rating: 1_500 },
    { nick: 'Wingman', rating: 1_400 },
    { nick: 'Ghost', rating: 1_999 },
  ])
  saveClanRatingSnapshots(CLAN_RAW_TAG, [
    { nick: 'PilotOne', rating: 1_520 },
    { nick: 'Wingman', rating: 1_400 },
  ])
  const formulaMembers = Array.from({ length: 130 }, (_, index) => ({
    nick: `Formula${index}`,
    rating: 1_000 + index,
  }))
  saveClanRatingSnapshots(FORMULA_CLAN_RAW_TAG, formulaMembers)
  saveClanRatingSnapshots(FORMULA_CLAN_RAW_TAG, formulaMembers)

  // Смена украшений тега: ядро «var» одно, VarTwo уходит после смены варианта
  // и не должен «воскреснуть» из-под старого написания.
  upsertClans([{ tag: '=VAR=', name: 'Variant Clan' }])
  saveClanRatingSnapshots('=VAR=', [{ nick: 'VarOne', rating: 1_000 }, { nick: 'VarTwo', rating: 900 }])
  saveClanRatingSnapshots('-VAR-', [{ nick: 'VarOne', rating: 1_010 }])

  // Неправдоподобное сжатие ростера (2 из 6): уходы не применяются.
  saveClanRatingSnapshots('=BIG=', [
    { nick: 'B1', rating: 100 }, { nick: 'B2', rating: 100 }, { nick: 'B3', rating: 100 },
    { nick: 'B4', rating: 100 }, { nick: 'B5', rating: 100 }, { nick: 'B6', rating: 100 },
  ])
  saveClanRatingSnapshots('=BIG=', [{ nick: 'B1', rating: 110 }, { nick: 'B2', rating: 100 }])

  // Бои: победа и поражение клана + одиночный replay-only игрок.
  saveBattle(battle('100200301', nowSec - 3_600, 1, [
    player('501', 'PilotOne', 1, 'test_tank', { clanTag: CLAN_RAW_TAG, score: 1_200 }),
    player('999', 'EnemyOne', 2, 'enemy_tank'),
  ]))
  saveBattle(battle('100200302', nowSec - 7_200, 2, [
    player('501', 'PilotOne', 1, 'test_tank', { clanTag: CLAN_RAW_TAG, score: 800 }),
    player('999', 'EnemyOne', 2, 'enemy_tank'),
  ]))
  saveBattle(battle('100200303', nowSec - 10_800, 1, [
    player('777', 'LoneWolf', 1, 'lone_plane'),
  ]))
  // Клановая пара против бесклановых: подпись «TST против случайных».
  saveBattle(battle('100200305', nowSec - 14_400, 1, [
    player('501', 'PilotOne', 1, 'test_tank', { clanTag: CLAN_RAW_TAG }),
    player('502', 'Wingman', 1, 'test_tank', { clanTag: CLAN_RAW_TAG }),
    player('601', 'RandoOne', 2, 'enemy_tank'),
    player('602', 'RandoTwo', 2, 'enemy_tank'),
  ]))

  // Бой с реальным events_blob — для проверки сцены плеера.
  const sceneEvents = {
    teamWon: 1,
    players: [],
    damage: [],
    chat: [],
    kills: [{
      time: 60_000,
      killerId: '501',
      killerModel: 'tankModels/test_tank',
      victimId: '999',
      victimModel: 'tankModels/enemy_tank',
      weapon: 'shell',
      killerPos: { x: 100, y: 10, z: 200 },
      victimPos: { x: 400, y: 10, z: 600 },
    }],
    units: [
      {
        userId: '501',
        model: 'tankModels/test_tank',
        source: 'ground',
        path: Array.from({ length: 400 }, (_unused, i) => ({ t: i * 250, x: i * 2, y: 5, z: 1_000 - i })),
      },
      {
        userId: '',
        model: 'tankModels/drone',
        source: 'air',
        path: [{ t: 0, x: 0, y: 100, z: 0 }, { t: 5_000, x: 500, y: 100, z: 500 }],
      },
    ],
    zones: [{ name: 'A', x: 500, z: 500 }],
    endTime: 120_000,
    errors: [],
  }
  saveBattle(battle('100200304', nowSec - 1_800, 1, [
    player('501', 'PilotOne', 1, 'test_tank', { clanTag: CLAN_RAW_TAG }),
    player('999', 'EnemyOne', 2, 'enemy_tank'),
  ], gzipSync(Buffer.from(JSON.stringify(sceneEvents), 'utf8'))))

  const app = buildServer(
    {
      getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
      refreshVoice: async () => ({ players: 0, clans: 0 }),
      playerStats: new PlayerStatsCoordinator({ externalService: null, externalSource: 'fixture' }),
    },
    {
      loadVehicleDict: async () => ({
        test_tank: { name: 'Test Tank', cls: 'T', country: 'usa' },
      }),
    },
  )

  try {
    // --- Поиск игроков ---
    const search = await app.inject({ method: 'GET', url: '/api/players?query=Pilot' })
    assert.equal(search.statusCode, 200)
    const searchBody = search.json() as { ok: true; players: { nick: string; origin: string; wtUserId: string | null }[] }
    assert.equal(searchBody.players[0]?.nick, 'PilotOne')
    assert.equal(searchBody.players[0]?.origin, 'identity')

    const searchById = await app.inject({ method: 'GET', url: '/api/players?query=501' })
    assert.equal((searchById.json() as { players: { wtUserId: string | null }[] }).players[0]?.wtUserId, '501')

    const shortQuery = await app.inject({ method: 'GET', url: '/api/players?query=P' })
    assert.equal(shortQuery.statusCode, 400)
    const controlQuery = await app.inject({ method: 'GET', url: `/api/players?query=${encodeURIComponent('Pi\u0001lot')}` })
    assert.equal(controlQuery.statusCode, 400)

    // --- Профиль по WT user id ---
    const profile = await app.inject({ method: 'GET', url: '/api/players/501' })
    assert.equal(profile.statusCode, 200)
    const profileBody = profile.json() as {
      ok: true
      player: { identityId: number | null; nick: string; wtUserId: string | null; aliases: unknown[] }
      rating: { rating: number; delta: number | null } | null
      accounts: { source: string; totals: unknown[]; vehicles: unknown[] }[]
      replay: { battles: number; wins: number; losses: number } | null
    }
    assert.equal(profileBody.player.nick, 'PilotOne')
    assert.equal(profileBody.player.identityId, identity.id)
    assert.equal(profileBody.rating?.rating, 1_520)
    assert.equal(profileBody.rating?.delta, 20)
    assert.equal(profileBody.accounts.length, 1)
    assert.equal(profileBody.accounts[0]?.source, 'statshark')
    assert.equal(profileBody.replay?.battles, 4)
    assert.equal(profileBody.replay?.wins, 3)
    assert.equal(profileBody.replay?.losses, 1)

    const profileByIdentity = await app.inject({ method: 'GET', url: `/api/players/identity/${identity.id}` })
    assert.equal(profileByIdentity.statusCode, 200)
    assert.equal((profileByIdentity.json() as { player: { nick: string } }).player.nick, 'PilotOne')

    const missingProfile = await app.inject({ method: 'GET', url: '/api/players/999999' })
    assert.equal(missingProfile.statusCode, 404)

    // --- Read-only гарантия: replay-only игрок не получает identity от GET ---
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lone = await app.inject({ method: 'GET', url: '/api/players/777' })
      assert.equal(lone.statusCode, 200)
      const loneBody = lone.json() as { player: { identityId: number | null; nick: string }; accounts: unknown[]; replay: { battles: number } | null }
      assert.equal(loneBody.player.identityId, null, 'GET-профиль не должен создавать identity')
      assert.equal(loneBody.player.nick, 'LoneWolf')
      assert.equal(loneBody.accounts.length, 0)
      assert.equal(loneBody.replay?.battles, 1)
    }

    // --- История ---
    const history = await app.inject({ method: 'GET', url: '/api/players/501/history?days=400' })
    assert.equal(history.statusCode, 200)
    const historyBody = history.json() as {
      ok: true
      rating: { rating: number }[]
      account: Record<string, { battles: number | null }[]>
      activity: { day: string; battles: number; wins: number }[]
    }
    assert.equal(historyBody.rating.length, 2)
    assert.equal(historyBody.account['statshark']?.length, 2)
    assert.equal(historyBody.account['statshark']?.[1]?.battles, 110)
    const activityTotal = historyBody.activity.reduce((sum, dayRow) => sum + dayRow.battles, 0)
    assert.equal(activityTotal, 4)

    // --- Плитки главной ---
    const siteStats = await app.inject({ method: 'GET', url: '/api/site-stats' })
    assert.equal(siteStats.statusCode, 200)
    const siteStatsBody = siteStats.json() as {
      season: { currentStage: { week: number; maxBr: number } | null }
      players: number; clans: number; battlesTotal: number; battlesWeek: number; byDay: { battles: number }[]
    }
    const expectedSeason = getClanSeasonContext()
    assert.equal(siteStatsBody.season.currentStage?.week, expectedSeason.currentStage?.week)
    assert.equal(siteStatsBody.season.currentStage?.maxBr, expectedSeason.currentStage?.maxBr)
    assert.equal(siteStatsBody.battlesTotal, 5)
    assert.equal(siteStatsBody.battlesWeek, 5)
    assert.equal(siteStatsBody.players, 6)
    assert.equal(siteStatsBody.clans, 4)
    assert.equal(siteStatsBody.byDay.reduce((sum, dayRow) => sum + dayRow.battles, 0), 5)

    // --- Кланы ---
    const clans = await app.inject({ method: 'GET', url: '/api/clans' })
    assert.equal(clans.statusCode, 200)
    const clansBody = clans.json() as {
      clans: {
        coreTag: string
        name: string | null
        members: number
        totalRating: number
        avgRating: number
        delta30d: number | null
        rank: number
        rosterKnown: boolean
      }[]
      season: { currentStage: { week: number; maxBr: number } | null }
    }
    assert.equal(clansBody.season.currentStage?.week, expectedSeason.currentStage?.week)
    assert.equal(clansBody.clans.length, 4)
    // Ранг — место в общем рейтинге, список отсортирован по нему.
    assert.deepEqual(clansBody.clans.map((clan) => clan.rank), [1, 2, 3, 4])
    assert.ok(clansBody.clans.every((clan) => typeof clan.rosterKnown === 'boolean'))
    const testClan = clansBody.clans.find((clan) => clan.coreTag === 'tst')
    assert.equal(testClan?.name, 'Test Clan')
    // Покинувший Ghost исключён из состава и суммы; базиса месяц назад нет.
    assert.equal(testClan?.members, 2)
    assert.equal(testClan?.totalRating, 1_520 + 1_400)
    assert.equal(testClan?.delta30d, null)
    const formulaClan = clansBody.clans.find((clan) => clan.coreTag === 'form')
    assert.equal(formulaClan?.members, 128, 'состав squadron не должен превышать игровой лимит')
    assert.equal(formulaClan?.totalRating, 28_090, 'Total PSR должен учитывать 20 лучших и 5% остальных')
    assert.equal(formulaClan?.avgRating, 1_066, 'Average должен быть обычным средним PSR состава')
    // Смена украшений: ядро группируется, ушедший под старым вариантом не в счёте.
    const varClan = clansBody.clans.find((clan) => clan.coreTag === 'var')
    assert.equal(varClan?.members, 1, 'смена украшений тега не должна воскрешать ушедшего')
    assert.equal(varClan?.totalRating, 1_010)
    // Защита от битого парса: сжатие 6 → 2 уходы не применяет.
    const bigClan = clansBody.clans.find((clan) => clan.coreTag === 'big')
    assert.equal(bigClan?.members, 6, 'неправдоподобное сжатие ростера не должно выгонять участников')

    const clanDetail = await app.inject({ method: 'GET', url: '/api/clans/TST' })
    assert.equal(clanDetail.statusCode, 200)
    const clanBody = clanDetail.json() as {
      clan: { coreTag: string; name: string | null; rank: number; delta30d: number | null; rosterKnown: boolean }
      roster: { nick: string; rating: number; delta: number | null; wtUserId: string | null; identityId: number | null }[]
      battles: { total: number; wins: number; losses: number; winRate: number | null }
      recent: unknown[]
    }
    assert.equal(clanBody.clan.coreTag, 'tst')
    // Страница клана получает ранг и дельту из самого ответа, а не из списка топ-100.
    assert.equal(clanBody.clan.rank, testClan?.rank)
    assert.equal(clanBody.clan.delta30d, testClan?.delta30d)
    assert.equal(clanBody.clan.rosterKnown, testClan?.rosterKnown)
    assert.equal(clanBody.roster[0]?.nick, 'PilotOne')
    assert.equal(clanBody.roster[0]?.delta, 20)
    assert.equal(clanBody.roster[0]?.wtUserId, '501', 'ростер должен линковаться через алиасы')
    assert.equal(clanBody.roster[1]?.identityId, null, 'без алиаса ссылки быть не должно')
    assert.equal(clanBody.roster.length, 2, 'покинувший Ghost не должен быть в ростере')
    assert.equal(clanBody.battles.total, 4)
    assert.equal(clanBody.battles.wins, 3)
    assert.equal(clanBody.battles.losses, 1)
    assert.ok(Math.abs((clanBody.battles.winRate ?? 0) - 3 / 4) < 1e-9)
    assert.equal(clanBody.recent.length, 4)

    // --- История суммы ПКР клана: по текущему составу, без Ghost ---
    const clanHistory = await app.inject({ method: 'GET', url: '/api/clans/tst/history?days=90' })
    assert.equal(clanHistory.statusCode, 200)
    const clanHistoryBody = clanHistory.json() as { points: { total: number }[]; truncated: boolean }
    assert.equal(clanHistoryBody.truncated, false)
    assert.equal(clanHistoryBody.points[clanHistoryBody.points.length - 1]?.total, 1_520 + 1_400)
    assert.ok(clanHistoryBody.points.every((point) => point.total < 1_999 + 1_400 + 1_500),
      'история не должна включать покинувшего Ghost')

    const missingClan = await app.inject({ method: 'GET', url: '/api/clans/none' })
    assert.equal(missingClan.statusCode, 404)
    const invalidClan = await app.inject({ method: 'GET', url: `/api/clans/${encodeURIComponent('=--=')}` })
    assert.equal(invalidClan.statusCode, 400)

    // --- Лента боёв ---
    const byPlayer = await app.inject({ method: 'GET', url: '/api/battles?player=501' })
    const byPlayerBody = byPlayer.json() as { battles: { player: { won: boolean | null } | null }[] }
    assert.equal(byPlayerBody.battles.length, 4)
    assert.equal(byPlayerBody.battles[0]?.player?.won, true)
    assert.equal(byPlayerBody.battles[2]?.player?.won, false)

    const byClan = await app.inject({ method: 'GET', url: '/api/battles?clan=tst' })
    const byClanBody = byClan.json() as {
      battles: { sessionId: string; clanSide: { won: boolean | null } | null }[]
    }
    assert.equal(byClanBody.battles.length, 4)
    assert.equal(byClanBody.battles.find((row) => row.sessionId === '100200301')?.clanSide?.won, true)
    assert.equal(byClanBody.battles.find((row) => row.sessionId === '100200302')?.clanSide?.won, false)

    const allBattles = await app.inject({ method: 'GET', url: '/api/battles?limit=10' })
    const allBattlesBody = allBattles.json() as {
      battles: { sessionId: string; teams: { team: number; clanTag: string | null }[] }[]
    }
    assert.equal(allBattlesBody.battles.length, 5)
    // Подписи команд: клановая пара помечена, бесклановые — null («случайные»).
    const labelled = allBattlesBody.battles.find((row) => row.sessionId === '100200305')
    assert.deepEqual(labelled?.teams.map((team) => team.clanTag), ['TST', null])
    const single = allBattlesBody.battles.find((row) => row.sessionId === '100200301')
    assert.deepEqual(single?.teams.map((team) => team.clanTag), [null, null],
      'один клановый игрок в команде не должен давать подпись')

    const badPeriod = await app.inject({ method: 'GET', url: '/api/battles?from=100&to=50' })
    assert.equal(badPeriod.statusCode, 400)

    // --- Скорборд ---
    const scoreboard = await app.inject({ method: 'GET', url: '/api/battles/100200301' })
    assert.equal(scoreboard.statusCode, 200)
    const scoreboardBody = scoreboard.json() as {
      battle: { sessionId: string; winnerKnown: boolean }
      teams: { team: number; won: boolean | null; players: { nick: string; clanCore: string | null }[] }[]
    }
    assert.equal(scoreboardBody.battle.sessionId, '100200301')
    assert.equal(scoreboardBody.battle.winnerKnown, true)
    const winnerTeam = scoreboardBody.teams.find((team) => team.won === true)
    assert.equal(winnerTeam?.players[0]?.nick, 'PilotOne')
    assert.equal(winnerTeam?.players[0]?.clanCore, 'tst')

    const hexKey = BigInt('100200301').toString(16).padStart(16, '0').toUpperCase()
    const scoreboardByHex = await app.inject({ method: 'GET', url: `/api/battles/${hexKey}` })
    assert.equal(scoreboardByHex.statusCode, 200)
    assert.equal((scoreboardByHex.json() as { battle: { sessionId: string } }).battle.sessionId, '100200301')

    const missingBattle = await app.inject({ method: 'GET', url: '/api/battles/424242' })
    assert.equal(missingBattle.statusCode, 404)
    const invalidBattle = await app.inject({ method: 'GET', url: '/api/battles/zzz' })
    assert.equal(invalidBattle.statusCode, 400)

    // --- Словарь техники (стаб) ---
    const vehicles = await app.inject({ method: 'GET', url: '/api/vehicles' })
    assert.equal(vehicles.statusCode, 200)
    assert.equal(
      (vehicles.json() as { vehicles: Record<string, { name: string }> }).vehicles['test_tank']?.name,
      'Test Tank',
    )
    assert.match(vehicles.headers['cache-control'] ?? '', /max-age=86400/)

    // --- Сцена боя для плеера ---
    const scene = await app.inject({ method: 'GET', url: '/api/battles/100200304/scene' })
    assert.equal(scene.statusCode, 200)
    assert.equal(scene.headers['content-encoding'], 'gzip')
    const sceneBody = JSON.parse(gunzipSync(scene.rawPayload).toString('utf8')) as {
      v: number
      units: { userId: string | null; source: string; path: [number, number, number][] }[]
      players: { nick: string }[]
      kills: { x: number | null }[]
      zones: unknown[]
      map: { available: boolean }
      worldBounds: number[]
      endTimeMs: number
    }
    assert.equal(sceneBody.v, 1)
    assert.equal(sceneBody.units.length, 2)
    const groundUnit = sceneBody.units.find((unit) => unit.source === 'ground')
    assert.ok(groundUnit && groundUnit.path.length >= 2 && groundUnit.path.length < 400,
      'траектория должна быть прорежена')
    assert.equal(sceneBody.units.find((unit) => unit.source === 'air')?.userId, null)
    assert.ok(sceneBody.players.some((entry) => entry.nick === 'PilotOne'))
    assert.equal(sceneBody.kills[0]?.x, 400)
    assert.equal(sceneBody.zones.length, 1)
    assert.equal(sceneBody.map.available, false)
    assert.equal(sceneBody.worldBounds.length, 4)
    assert.ok(sceneBody.endTimeMs >= 120_000)

    const sceneMissing = await app.inject({ method: 'GET', url: '/api/battles/100200301/scene' })
    assert.equal(sceneMissing.statusCode, 404)
    assert.equal((sceneMissing.json() as { code: string }).code, 'SCENE_UNAVAILABLE')

    const mapMissing = await app.inject({ method: 'GET', url: '/api/battles/100200304/map.png' })
    assert.equal(mapMissing.statusCode, 404)
    assert.equal((mapMissing.json() as { code: string }).code, 'MAP_UNAVAILABLE')

    // --- SPA (только при собранном frontend/dist) ---
    if (spaDistAvailable()) {
      const spaIndex = await app.inject({ method: 'GET', url: '/app' })
      assert.equal(spaIndex.statusCode, 200)
      assert.match(spaIndex.headers['content-type'] ?? '', /text\/html/)
      const spaFallback = await app.inject({ method: 'GET', url: '/app/players/12345' })
      assert.equal(spaFallback.statusCode, 200, 'клиентские маршруты должны отдавать index.html')
      assert.match(spaFallback.headers['content-type'] ?? '', /text\/html/)
    }

    // --- Weighted rate limit дорогого battle-фильтра ---
    for (let i = 0; i < 16; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/battles?player=501',
        remoteAddress: '198.51.100.10',
      })
      if (i < 15) {
        assert.equal(response.statusCode, 200)
      } else {
        assert.equal(response.statusCode, 429)
        assert.ok(Number(response.headers['retry-after']) >= 1)
      }
    }

    // --- Официальный лидерборд: рейтинг и место кланов — из него ---
    // Снимок кланов кэшируется в экземпляре приложения, поэтому после записи
    // лидерборда проверяется отдельный экземпляр.
    const seasonStart = getClanSeasonContext().season?.startsAt ?? 0
    const baseAt = Math.max(seasonStart, 1)
    const fullCrawlAt = nowSec - 7_200
    const topCrawlAt = nowSec - 600
    const lbClan = (tag: string, name: string, rating: number, position: number, extra: object = {}) => ({
      tag, name, rating, position, members: null, battles: null, wins: null, ...extra,
    })
    saveClanLeaderboard([lbClan('[AVR]', 'AVANGARD', 40_000, 1)], baseAt)
    saveClanLeaderboard([
      lbClan('[AVR]', 'AVANGARD', 48_307, 1, { members: 121, battles: 2_540, wins: 2_270 }),
      lbClan(CLAN_RAW_TAG, 'Test Clan', 3_000, 2, { members: 2, battles: 10, wins: 6 }),
      lbClan('[OLD]', 'Dropped Clan', 2_900, 3),
    ], fullCrawlAt)
    saveClanLeaderboard([
      lbClan('[AVR]', 'AVANGARD', 48_400, 1, { members: 121, battles: 2_545, wins: 2_274 }),
      lbClan(CLAN_RAW_TAG, 'Test Clan', 3_000, 2, { members: 2, battles: 11, wins: 7 }),
      lbClan('[NEW]', 'Newcomer', 2_800, 3),
    ], topCrawlAt)
    const officialApp = buildServer(
      {
        getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
        refreshVoice: async () => ({ players: 0, clans: 0 }),
        playerStats: new PlayerStatsCoordinator({ externalService: null, externalSource: 'fixture' }),
      },
      { loadVehicleDict: async () => ({}) },
    )
    try {
      const officialClans = await officialApp.inject({ method: 'GET', url: '/api/clans' })
      assert.equal(officialClans.statusCode, 200)
      const officialList = (officialClans.json() as {
        clans: {
          coreTag: string; name: string | null; totalRating: number; members: number; avgRating: number | null
          seasonBattles: number | null; seasonWins: number | null; delta30d: number | null; rank: number; lastSeenAt: number
        }[]
      }).clans
      // Выпавший из свежего обхода [OLD] ниже свежих кланов, хотя его прежний
      // рейтинг выше, а кланы без официальных данных — после всех официальных.
      assert.deepEqual(officialList.slice(0, 4).map((clan) => clan.coreTag), ['avr', 'tst', 'new', 'old'])
      assert.deepEqual(officialList.slice(0, 4).map((clan) => clan.rank), [1, 2, 3, 4])
      assert.equal(officialList.find((clan) => clan.coreTag === 'form')?.rank, 5, 'сумма ПКР не должна обгонять официальных')
      const leader = officialList[0]
      assert.equal(leader?.name, 'AVANGARD')
      assert.equal(leader?.totalRating, 48_400)
      assert.equal(leader?.members, 121)
      assert.equal(leader?.seasonBattles, 2_545)
      assert.equal(leader?.seasonWins, 2_274)
      assert.equal(leader?.avgRating, null, 'без снимков состава средний ПКР неизвестен')
      assert.equal(leader?.lastSeenAt, topCrawlAt)
      assert.equal(leader?.delta30d, 48_400 - 40_000, 'дельта — от официального значения месяц назад')
      const officialTst = officialList.find((clan) => clan.coreTag === 'tst')
      assert.equal(officialTst?.totalRating, 3_000, 'официальный рейтинг заменяет сумму снимков ПКР')
      assert.equal(officialTst?.avgRating, 1_460, 'средний ПКР по снимкам состава сохраняется')

      const leaderDetail = await officialApp.inject({ method: 'GET', url: '/api/clans/avr' })
      assert.equal(leaderDetail.statusCode, 200, 'клан лидерборда без снимков ПКР должен открываться')
      const leaderBody = leaderDetail.json() as {
        clan: { rank: number; members: number; totalRating: number; seasonBattles: number | null; seasonWins: number | null }
        roster: unknown[]
      }
      assert.equal(leaderBody.clan.rank, 1)
      assert.equal(leaderBody.clan.members, 121)
      assert.equal(leaderBody.clan.totalRating, 48_400)
      assert.equal(leaderBody.clan.seasonBattles, 2_545)
      assert.equal(leaderBody.clan.seasonWins, 2_274)
      assert.equal(leaderBody.roster.length, 0)

      const leaderHistory = await officialApp.inject({ method: 'GET', url: '/api/clans/avr/history?days=90' })
      const leaderPoints = (leaderHistory.json() as { points: { t: number; total: number }[] }).points
      assert.deepEqual(leaderPoints.map((point) => point.total), [40_000, 48_307, 48_400])
      assert.equal(leaderPoints[leaderPoints.length - 1]?.t, topCrawlAt)

      const leaderBattles = await officialApp.inject({ method: 'GET', url: '/api/battles?clan=avr' })
      assert.equal(leaderBattles.statusCode, 200)
      const officialStats = await officialApp.inject({ method: 'GET', url: '/api/site-stats' })
      assert.equal((officialStats.json() as { clans: number }).clans, 7, 'счётчик кланов включает официальные')
    } finally {
      await officialApp.close()
    }

    // --- Rate limit (последним: исчерпывает per-IP корзину) ---
    let limited = false
    for (let i = 0; i < 70; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/clans' })
      if (response.statusCode === 429) {
        assert.ok(Number(response.headers['retry-after']) >= 1)
        limited = true
        break
      }
    }
    assert.ok(limited, 'per-IP rate limit должен сработать')

    console.log('[site-api-smoke] OK: поиск, профили, история, кланы, бои, сцена, словарь, SPA и rate limit')
  } finally {
    // smoke пишет scene-кэш в реальный data/battles — убираем за собой
    const sceneHex = BigInt('100200304').toString(16).padStart(16, '0')
    await rm(`./data/battles/${sceneHex}-scene-v1.json.gz`, { force: true }).catch(() => undefined)
    await app.close()
    await closeWorkerPool()
    closeDb()
  }
}

await main()
