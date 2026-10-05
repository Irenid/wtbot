// Оффлайн-smoke read-модели сайта: SQLite :memory: + Fastify inject().
// Проверяет поиск, профили, историю, кланы, ленты боёв, скорборд, словарь
// техники, rate limit и read-only гарантию GET-профилей.
// Запуск: npm run verify:site-api
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  CLAN_FULL_CRAWL_KEY,
  closeDb,
  getClanSeasonContext,
  initDb,
  recordParseResult,
  saveBattle,
  saveClanLeaderboard,
  saveClanRatingSnapshots,
  savePlayerExternalSnapshot,
  savePlayerIdentity,
  setBotState,
  upsertClans,
  type BattleInput,
  type BattlePlayerInput,
} from '../db/index.js'
import { PlayerStatsCoordinator } from '../player-stats/comparison.js'
import { WtUserIdResolver } from '../player-stats/id-lookup.js'
import { closeWorkerPool } from '../workers/pool.js'
import { buildServer } from '../web/index.js'
import { DASHBOARD_PATH } from '../web/routes/pages.js'
import { spaDistAvailable } from '../web/routes/spa.js'
import { BATTLE_SCENE_VERSION } from '../wrpl/battle-scene-core.js'

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
    normalized: {
      ...aggregateTotals(110, 61),
      // Аккаунт StatShark: клан из истории, известный сайту, получает ядро тега.
      account: {
        level: 100,
        title: 'The Old Guard',
        registeredAt: 1_373_452_206,
        lastOnlineAt: nowSec - 86_400,
        squadrons: [
          { clanId: 1, tag: CLAN_RAW_TAG, seenAt: nowSec - 3_600 },
          { clanId: 2, tag: '-NOWHERE-', seenAt: nowSec - 99_999 },
        ],
        names: [{ nick: 'PilotOne', seenAt: nowSec - 99_999 }],
        ranks: [{ mode: 'historical', metric: 'victories', value: 61, place: 3_778 }],
        rankHistory: [],
      },
    },
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
    { nick: 'PilotOne', rating: 1_520, role: 'Commander', joinedAt: nowSec - 400 * 86_400, activity: 1_234 },
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

  // Seen in an earlier season's battles: this season's PSR is zero for every member.
  saveClanRatingSnapshots('=NIL=', [{ nick: 'NilOne', rating: 0 }, { nick: 'NilTwo', rating: 0 }])

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
    }, {
      time: 90_000,
      killerId: '-7',
      killerModel: 'tankModels/enemy_tank',
      victimId: '501',
      victimModel: 'tankModels/test_tank',
      weapon: 'shell',
      killerPos: null,
      victimPos: { x: 300, y: 10, z: 500 },
    }],
    units: [
      {
        userId: '-7',
        model: 'tankModels/enemy_tank',
        source: 'ground',
        path: [{ t: 1_000, x: 600, y: 5, z: 600 }, { t: 9_000, x: 650, y: 5, z: 640 }],
      },
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
  // A bot slot (-7) played for Absent, who never loaded in (player-events.ts);
  // Lost has no known team.
  const absent = { vehicle: 'enemy_tank', vehicles: [], disconnected: true, score: 300 }
  saveBattle(battle('100200304', nowSec - 1_800, 1, [
    player('501', 'PilotOne', 1, 'test_tank', { clanTag: CLAN_RAW_TAG }),
    player('999', 'EnemyOne', 2, 'enemy_tank'),
    player('503', 'Absent', 2, 'enemy_tank', { ...absent, playedVehicles: ['enemy_tank'], botUserId: '-7' }),
    player('-7', 'coop/Bot7', 2, 'enemy_tank', { ...absent, playedVehicles: ['enemy_tank'], score: 0 }),
    player('504', 'Lost', 0, 'enemy_tank', { vehicle: null, vehicles: [], playedVehicles: [], disconnected: true, score: 0 }),
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
      accounts: {
        source: string
        totals: unknown[]
        vehicles: unknown[]
        countries: unknown[]
        account: {
          level: number | null
          squadrons: { tag: string; coreTag: string | null }[]
          ranks: { place: number }[]
        } | null
      }[]
      clan: { coreTag: string | null; role: string | null; joinedAt: number | null; rank: number | null } | null
      replay: { battles: number; wins: number; losses: number } | null
    }
    assert.equal(profileBody.player.nick, 'PilotOne')
    assert.equal(profileBody.player.identityId, identity.id)
    assert.equal(profileBody.rating?.rating, 1_520)
    assert.equal(profileBody.rating?.delta, 20)
    assert.equal(profileBody.accounts.length, 1)
    assert.equal(profileBody.accounts[0]?.source, 'statshark')
    assert.deepEqual(profileBody.accounts[0]?.countries, [], 'нации есть только у официального профиля')
    const account = profileBody.accounts[0]?.account
    assert.equal(account?.level, 100)
    assert.deepEqual(account?.squadrons.map((squadron) => squadron.coreTag), ['tst', null],
      'ссылка только на клан, который есть на сайте')
    assert.equal(account?.ranks[0]?.place, 3_778)
    // Клан игрока: по снимку ПКР сезона, роль и дата — из ростера claninfo.
    assert.equal(profileBody.clan?.coreTag, 'tst')
    assert.equal(profileBody.clan?.role, 'Commander')
    assert.equal(profileBody.clan?.joinedAt, nowSec - 400 * 86_400)
    assert.ok((profileBody.clan?.rank ?? 0) >= 1)

    // --- Аналитика по реплеям: та же выборка боёв, что у replay-статистики ---
    const insights = await app.inject({ method: 'GET', url: '/api/players/501/insights?days=30' })
    assert.equal(insights.statusCode, 200)
    const insightsBody = insights.json() as {
      days: number
      insights: { battles: number; starts: number[]; maps: { battles: number }[]; teammates: { nick: string }[] } | null
    }
    assert.equal(insightsBody.days, 30)
    assert.equal(insightsBody.insights?.battles, 4)
    assert.equal(insightsBody.insights?.starts.length, 4)
    assert.equal(insightsBody.insights?.maps[0]?.battles, 4)
    assert.deepEqual(insightsBody.insights?.teammates.map((mate) => mate.nick), ['Wingman'])
    const insightsByIdentity = await app.inject({ method: 'GET', url: `/api/players/identity/${identity.id}/insights` })
    assert.equal((insightsByIdentity.json() as { insights: { battles: number } | null }).insights?.battles, 4)
    assert.equal((await app.inject({ method: 'GET', url: '/api/players/999999/insights' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/api/players/501/insights?days=1' })).statusCode, 400)
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

    // --- Profile by nick (squadron members): an id when local data knows one ---
    type NickProfile = {
      player: { identityId: number | null; wtUserId: string | null; nick: string }
      rating: { rating: number } | null
      clan: { coreTag: string | null } | null
      accounts: unknown[]
      replay: { battles: number } | null
    }
    const byNick = async (nick: string, suffix = '') =>
      app.inject({ method: 'GET', url: `/api/players/nick/${encodeURIComponent(nick)}${suffix}` })
    const wingman = await byNick('Wingman')
    assert.equal(wingman.statusCode, 200)
    const wingmanBody = wingman.json() as NickProfile
    assert.equal(wingmanBody.player.wtUserId, '502', 'a replay id resolves the nick')
    assert.equal(wingmanBody.player.identityId, null)
    assert.equal(wingmanBody.rating?.rating, 1_400)
    assert.equal(wingmanBody.replay?.battles, 1)
    const pilotByNick = (await byNick('pilotone')).json() as NickProfile
    assert.equal(pilotByNick.player.identityId, identity.id, 'a case-folded nick resolves the identity')
    assert.equal(pilotByNick.player.nick, 'PilotOne')
    // Known only from the squadron roster: PSR and squadron, no id, no replays.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const member = await byNick('Formula7')
      assert.equal(member.statusCode, 200)
      const memberBody = member.json() as NickProfile
      assert.equal(memberBody.player.identityId, null, 'a GET by nick must not create an identity')
      assert.equal(memberBody.player.wtUserId, null)
      assert.equal(memberBody.player.nick, 'Formula7')
      assert.equal(memberBody.rating?.rating, 1_007)
      assert.equal(memberBody.clan?.coreTag, 'form')
      assert.equal(memberBody.accounts.length, 0)
      assert.equal(memberBody.replay, null)
    }
    const memberHistory = await byNick('Formula7', '/history?days=30')
    assert.equal(memberHistory.statusCode, 200)
    const memberHistoryBody = memberHistory.json() as { rating: unknown[]; activity: unknown[] }
    assert.ok(memberHistoryBody.rating.length >= 1)
    assert.deepEqual(memberHistoryBody.activity, [])
    const memberInsights = await byNick('Formula7', '/insights')
    assert.equal(memberInsights.statusCode, 200)
    assert.equal((memberInsights.json() as { insights: unknown }).insights, null)
    assert.equal((await byNick('Nobody')).statusCode, 404)
    // A numeric nick is a nick, not WT user id 501.
    assert.equal((await byNick('501')).statusCode, 404)
    assert.equal((await byNick('Pi\u0001lot')).statusCode, 400)
    assert.equal((await byNick('x'.repeat(65))).statusCode, 400)

    // --- WT user id lookup: the nick page's POST links the member everywhere ---
    const searched: string[] = []
    const idApp = buildServer({
      getBotStatus: () => ({ online: false, tag: null, guilds: 0, uptimeSec: 0 }),
      refreshVoice: async () => ({ players: 0, clans: 0 }),
      playerStats: new PlayerStatsCoordinator({ externalService: null, externalSource: 'fixture' }),
      playerIdLookup: new WtUserIdResolver({
        steps: [{
          source: 'fixture-search',
          minIntervalMs: 0,
          find: async (nick) => {
            searched.push(nick)
            return [{ wtUserId: '9007', nick: 'Formula7' }, { wtUserId: '9070', nick: 'Formula70' }]
          },
        }],
        log: () => undefined,
      }),
    })
    try {
      const lookupId = (nick: string) => idApp.inject({
        method: 'POST',
        url: '/api/player-id',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ nick }),
      })
      const resolved = await lookupId('Formula7')
      assert.equal(resolved.statusCode, 200)
      assert.deepEqual(resolved.json(), { ok: true, status: 'found', wtUserId: '9007' })
      assert.equal((await lookupId('Nobody')).statusCode, 404, 'a nick unknown locally reaches no source')
      assert.deepEqual(searched, ['Formula7'])
      assert.equal(((await byNick('Formula7')).json() as NickProfile).player.wtUserId, '9007', 'the nick page opens the id')
      const byId = await app.inject({ method: 'GET', url: '/api/players/9007' })
      assert.equal(byId.statusCode, 200)
      const byIdBody = byId.json() as NickProfile
      assert.equal(byIdBody.player.nick, 'Formula7')
      assert.equal(byIdBody.rating?.rating, 1_007)
      const formClan = await app.inject({ method: 'GET', url: '/api/clans/form' })
      assert.equal(formClan.statusCode, 200)
      const formRoster = (formClan.json() as { roster: { nick: string; wtUserId: string | null }[] }).roster
      assert.equal(formRoster.find((member) => member.nick === 'Formula7')?.wtUserId, '9007', 'the roster links the found id')
      assert.equal(formRoster.find((member) => member.nick === 'Formula70')?.wtUserId, null, 'a prefix match links nothing')
    } finally {
      await idApp.close()
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
    // Distinct user ids of battle_players: with the bot slot and the team-0 row of 100200304
    assert.equal(siteStatsBody.players, 9)
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
        delta24h: number | null
        leaderboard: string | null
        rank: number
        rosterKnown: boolean
      }[]
      season: { currentStage: { week: number; maxBr: number } | null }
      updatedAt: number | null
      leaderRating: number | null
      live: unknown
    }
    assert.equal(clansBody.season.currentStage?.week, expectedSeason.currentStage?.week)
    assert.equal(clansBody.live, null, 'no successful wt-replays run: no live marks')
    assert.equal(clansBody.clans.length, 4)
    // Ранг — место в общем рейтинге, список отсортирован по нему.
    assert.deepEqual(clansBody.clans.map((clan) => clan.rank), [1, 2, 3, 4])
    assert.equal(clansBody.leaderRating, clansBody.clans[0]?.totalRating)
    assert.ok(clansBody.clans.every((clan) => typeof clan.rosterKnown === 'boolean'))
    const testClan = clansBody.clans.find((clan) => clan.coreTag === 'tst')
    assert.equal(testClan?.name, 'Test Clan')
    // Ghost, who left, is out of the roster and the sum; a PSR-rated squadron has no leaderboard
    // status, 24 h change or crawl time.
    assert.equal(testClan?.members, 2)
    assert.equal(testClan?.totalRating, 1_520 + 1_400)
    assert.equal(testClan?.delta24h, null)
    assert.equal(testClan?.leaderboard, null)
    assert.equal(clansBody.updatedAt, null)
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

    // Paging: total describes the whole ranking, not the page.
    const clansPage = await app.inject({ method: 'GET', url: '/api/clans?offset=2&limit=1' })
    assert.equal(clansPage.statusCode, 200)
    const clansPageBody = clansPage.json() as { total: number; clans: { rank: number }[] }
    assert.equal(clansPageBody.total, 4)
    assert.deepEqual(clansPageBody.clans.map((clan) => clan.rank), [3])
    const clansPastEnd = await app.inject({ method: 'GET', url: '/api/clans?offset=10' })
    assert.deepEqual((clansPastEnd.json() as { total: number; clans: unknown[] }).clans, [])
    const clansBadLimit = await app.inject({ method: 'GET', url: '/api/clans?limit=101' })
    assert.equal(clansBadLimit.statusCode, 400, 'a page is at most 100 squadrons')

    // Search: the tag without decorations or case, or the name; a match keeps its place.
    const searchClans = async (query: string): Promise<{ total: number; clans: { coreTag: string; rank: number }[] }> => {
      const response = await app.inject({ method: 'GET', url: `/api/clans?query=${encodeURIComponent(query)}` })
      assert.equal(response.statusCode, 200)
      return response.json() as { total: number; clans: { coreTag: string; rank: number }[] }
    }
    const tagSearch = await searchClans('=tst=')
    assert.deepEqual(tagSearch.clans.map((clan) => clan.coreTag), ['tst'])
    assert.equal(tagSearch.total, 1)
    assert.equal(tagSearch.clans[0]?.rank, testClan?.rank)
    assert.deepEqual((await searchClans('VARIANT')).clans.map((clan) => clan.coreTag), ['var'], 'the name matches too')
    const noMatch = await searchClans('zzz')
    assert.equal(noMatch.total, 0)
    assert.deepEqual(noMatch.clans, [])
    const longQuery = await app.inject({ method: 'GET', url: `/api/clans?query=${'x'.repeat(65)}` })
    assert.equal(longQuery.statusCode, 400, 'a query is at most 64 characters')

    const clanDetail = await app.inject({ method: 'GET', url: '/api/clans/TST' })
    assert.equal(clanDetail.statusCode, 200)
    const clanBody = clanDetail.json() as {
      clan: {
        coreTag: string
        name: string | null
        rank: number
        delta30d: number | null
        rosterKnown: boolean
        profile: unknown
      }
      roster: {
        nick: string
        rating: number
        delta: number | null
        wtUserId: string | null
        identityId: number | null
        role: string | null
        joinedAt: number | null
        activity: number | null
      }[]
      battles: { total: number; wins: number; losses: number; winRate: number | null; collectedSince: number | null }
      recent: unknown[]
    }
    assert.equal(clanBody.clan.coreTag, 'tst')
    // The squadron page gets its rank from its own response, not from a page of the list; no
    // baseline a month ago, so no 30-day delta.
    assert.equal(clanBody.clan.rank, testClan?.rank)
    assert.equal(clanBody.clan.delta30d, null)
    assert.equal(clanBody.clan.rosterKnown, testClan?.rosterKnown)
    assert.equal(clanBody.roster[0]?.nick, 'PilotOne')
    assert.equal(clanBody.roster[0]?.delta, 20)
    assert.equal(clanBody.roster[0]?.wtUserId, '501', 'ростер должен линковаться через алиасы')
    assert.equal(clanBody.roster[1]?.identityId, null, 'no alias: no identity link')
    assert.equal(clanBody.roster[1]?.wtUserId, '502', 'no alias: the single WT user id of the nick in replays')
    // Роль, дата вступления и активность — со страницы клана; у Wingman их нет.
    assert.equal(clanBody.roster[0]?.role, 'Commander')
    assert.equal(clanBody.roster[0]?.joinedAt, nowSec - 400 * 86_400)
    assert.equal(clanBody.roster[0]?.activity, 1_234)
    assert.equal(clanBody.roster[1]?.role, null)
    assert.equal(clanBody.clan.profile, null, 'профиль есть только у клана из лидерборда')
    assert.equal(clanBody.roster.length, 2, 'покинувший Ghost не должен быть в ростере')
    assert.equal(clanBody.battles.total, 4)
    assert.equal(clanBody.battles.wins, 3)
    assert.equal(clanBody.battles.losses, 1)
    assert.ok(Math.abs((clanBody.battles.winRate ?? 0) - 3 / 4) < 1e-9)
    assert.equal(clanBody.recent.length, 4)
    assert.equal(clanBody.battles.collectedSince, null, 'у клана с боями дата начала сбора не нужна')
    // Клан без боёв в реплеях: страница пишет, с какого дня бот собирает бои.
    const quietClan = await app.inject({ method: 'GET', url: '/api/clans/var' })
    assert.equal(quietClan.statusCode, 200)
    const quietBattles = (quietClan.json() as { battles: { total: number; collectedSince: number | null } }).battles
    assert.equal(quietBattles.total, 0)
    assert.ok(quietBattles.collectedSince !== null && quietBattles.collectedSince <= nowSec,
      'collectedSince — время первого боя в базе')

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

    // No card for team 0; the bot row folds into the player it played for.
    const botBattle = (await app.inject({ method: 'GET', url: '/api/battles/100200304' })).json() as {
      teams: { team: number; players: { nick: string; vehicles: string[]; bot: boolean; disconnected: boolean }[] }[]
    }
    assert.deepEqual(botBattle.teams.map((team) => team.team).sort(), [1, 2])
    const botTeam = botBattle.teams.find((team) => team.team === 2)
    assert.deepEqual(botTeam?.players.map((entry) => entry.nick), ['EnemyOne', 'Absent'])
    const absentRow = botTeam?.players[1]
    assert.deepEqual([absentRow?.vehicles, absentRow?.bot, absentRow?.disconnected], [['enemy_tank'], true, true])
    assert.equal(botTeam?.players[0]?.bot, false)

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
      kills: { x: number | null; killerId: string | null }[]
      zones: unknown[]
      map: { available: boolean }
      worldBounds: number[]
      endTimeMs: number
    }
    assert.equal(sceneBody.v, BATTLE_SCENE_VERSION)
    assert.equal(sceneBody.units.length, 3)
    // The bot slot's track and kill belong to the player it played for
    assert.equal(sceneBody.units[0]?.userId, '503')
    assert.equal(sceneBody.kills[1]?.killerId, '503')
    assert.deepEqual(sceneBody.players.map((entry) => entry.nick).sort(), ['Absent', 'EnemyOne', 'PilotOne'])
    const groundUnit = sceneBody.units.find((unit) => unit.source === 'ground' && unit.userId === '501')
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

    // --- SPA at the root (only with a built frontend/dist) ---
    const dashboard = await app.inject({ method: 'GET', url: DASHBOARD_PATH })
    assert.equal(dashboard.statusCode, 200)
    assert.match(dashboard.body, /\/api\/dashboard/)
    const legacy = await app.inject({ method: 'GET', url: '/app/players/12345?days=30' })
    assert.equal(legacy.statusCode, 301)
    assert.equal(legacy.headers['location'], '/players/12345?days=30')
    const unknownApi = await app.inject({ method: 'GET', url: '/api/nope' })
    assert.equal(unknownApi.statusCode, 404)
    assert.equal((unknownApi.json() as { code: string }).code, 'NOT_FOUND')
    if (spaDistAvailable()) {
      const spaIndex = await app.inject({ method: 'GET', url: '/' })
      assert.equal(spaIndex.statusCode, 200)
      assert.match(spaIndex.headers['content-type'] ?? '', /text\/html/)
      assert.equal(spaIndex.headers['cache-control'], 'no-cache')
      const spaFallback = await app.inject({ method: 'GET', url: '/players/12345' })
      assert.equal(spaFallback.statusCode, 200, 'client-side routes get index.html')
      assert.match(spaFallback.headers['content-type'] ?? '', /text\/html/)
      const license = await app.inject({ method: 'GET', url: '/LICENSE.txt' })
      assert.equal(license.statusCode, 200)
      assert.match(license.headers['content-type'] ?? '', /text\/plain/)
      const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing-0000.js' })
      assert.equal(missingAsset.statusCode, 404, 'a missing build asset is not index.html')
      assert.doesNotMatch(missingAsset.headers['content-type'] ?? '', /text\/html/)
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

    // --- Official leaderboard: squadron rating and place come from it ---
    // The squadron snapshot is cached per app instance, so a separate instance checks the
    // leaderboard written here.
    const seasonStart = getClanSeasonContext().season?.startsAt ?? 0
    const baseAt = Math.max(seasonStart, 1)
    const fullCrawlAt = nowSec - 7_200
    const oldCrawlAt = fullCrawlAt - 600
    const topCrawlAt = nowSec - 600
    // A point just before the leader's 24 h mark, unless the season began later than that.
    const dayMark = topCrawlAt - 86_400
    const dayAgoAt = dayMark - 60
    const lbClan = (tag: string, name: string, rating: number, position: number, extra: object = {}) => ({
      tag, name, rating, position, members: null, battles: null, wins: null, ...extra,
    })
    saveClanLeaderboard([lbClan('[AVR]', 'AVANGARD', 40_000, 1)], baseAt)
    const hasDayPoints = dayAgoAt > baseAt
    // The crawl log starts before the day marks (production keeps 3 days): without it a read is
    // not known to be the nearest. Unchanged figures add no history point.
    const logStartAt = dayMark - 8 * 3_600
    if (logStartAt > baseAt) saveClanLeaderboard([lbClan('[AVR]', 'AVANGARD', 40_000, 1)], logStartAt)
    if (hasDayPoints) {
      // A full crawl a day ago: [OLD], second then, has dropped out since; [AV] was [AVX] then (one
      // leaderboard _id).
      saveClanLeaderboard([
        lbClan('[AVR]', 'AVANGARD', 47_000, 1, { battles: 2_500, wins: 2_240 }),
        lbClan('[OLD]', 'Dropped Clan', 3_100, 2),
        lbClan('[AVX]', 'Av Squad', 2_950, 3, { clanId: 77 }),
        lbClan('[LOW]', 'Lower Clan', 2_600, 4),
      ], dayAgoAt, { full: true })
    }
    saveClanLeaderboard([lbClan('[OLD]', 'Dropped Clan', 2_950, 3), lbClan('[ZRO]', 'Zero Clan', 0, 4)], oldCrawlAt)
    saveClanLeaderboard([
      lbClan('[AVR]', 'AVANGARD', 48_307, 1, { members: 121, battles: 2_540, wins: 2_270 }),
      lbClan(CLAN_RAW_TAG, 'Test Clan', 3_000, 2, { members: 2, battles: 10, wins: 6 }),
      lbClan('[LOW]', 'Lower Clan', 2_700, 3),
    ], fullCrawlAt, { full: true })
    setBotState(CLAN_FULL_CRAWL_KEY, String(fullCrawlAt))
    saveClanLeaderboard([
      lbClan('[AVR]', 'AVANGARD', 48_400, 1, { members: 121, battles: 2_545, wins: 2_274 }),
      lbClan(CLAN_RAW_TAG, 'Test Clan', 3_000, 2, { members: 2, battles: 11, wins: 7 }),
      lbClan('[NEW]', 'Newcomer', 2_800, 3),
      lbClan('[AV]', 'Av Squad', 2_750, 4, { clanId: 77 }),
    ], topCrawlAt)
    // Playing now comes from replays: [TST]'s battle 100200304 ended 20 min ago, [AVR] has two,
    // [LOW] one; a team of two tags (a random battle) counts for nobody, and a battle that ended
    // an hour ago is out of the window.
    saveBattle(battle('100200310', nowSec - 2_100, 1, [
      player('901', 'AvrOne', 1, 'test_tank', { clanTag: '[AVR]' }),
      player('902', 'AvrTwo', 1, 'test_tank', { clanTag: '[AVR]' }),
      player('903', 'LowOne', 2, 'enemy_tank', { clanTag: '[LOW]' }),
    ]))
    saveBattle(battle('100200311', nowSec - 1_500, 2, [
      player('901', 'AvrOne', 1, 'test_tank', { clanTag: '[AVR]' }),
      player('904', 'AvOne', 2, 'enemy_tank', { clanTag: '[AV]' }),
      player('905', 'NewOne', 2, 'enemy_tank', { clanTag: '[NEW]' }),
    ]))
    saveBattle(battle('100200312', nowSec - 4_200, 1, [
      player('905', 'NewOne', 1, 'test_tank', { clanTag: '[NEW]' }),
      player('906', 'NewTwo', 1, 'test_tank', { clanTag: '[NEW]' }),
    ]))
    recordParseResult('wt-replays', true, 'fixture', null)
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
      type ClansBody = {
        total: number
        updatedAt: number | null
        leaderRating: number | null
        tierCutoffs: { place: number; rating: number }[]
        records: { winRate: string | null; kd: string | null; battles: string | null; gain: string | null }
        live: { count: number; at: number; windowSec: number } | null
        clans: {
          coreTag: string; name: string | null; totalRating: number; members: number; avgRating: number | null
          seasonBattles: number | null; seasonWins: number | null; delta24h: number | null
          delta24hFrom: number | null; delta24hTo: number | null
          battles24h: number | null; wins24h: number | null; rankChange24h: number | null
          recentBattles: number; aboveRating: number | null
          leaderboard: string | null; rank: number; lastSeenAt: number
        }[]
      }
      const officialBody = officialClans.json() as ClansBody
      const officialList = officialBody.clans
      // The latest crawl first; [LOW], read only by the last full crawl, after it; [ZRO], a zero
      // below the part the full crawl reads, is still in the table; [OLD], missed by the last full
      // crawl, after every squadron in the table despite its higher rating; squadrons without
      // official data after all of them.
      assert.deepEqual(officialList.slice(0, 7).map((clan) => clan.coreTag), ['avr', 'tst', 'new', 'av', 'low', 'zro', 'old'])
      assert.deepEqual(officialList.slice(0, 7).map((clan) => clan.rank), [1, 2, 3, 4, 5, 6, 7])
      assert.deepEqual(
        officialList.slice(0, 7).map((clan) => clan.leaderboard),
        ['current', 'current', 'current', 'current', 'current', 'current', 'dropped'],
      )
      assert.equal(officialList.find((clan) => clan.coreTag === 'form')?.rank, 8, 'a PSR sum must not outrank official squadrons')
      assert.equal(officialList.find((clan) => clan.coreTag === 'form')?.leaderboard, null)
      // No season rating at all: out of the list, its page still opens.
      assert.equal(officialList.some((clan) => clan.coreTag === 'nil'), false)
      assert.equal((await officialApp.inject({ method: 'GET', url: '/api/clans/nil' })).statusCode, 200)
      // The page mixes the latest and the full crawl: the older one is the page's time ([ZRO]'s
      // zero is confirmed by the full crawl).
      assert.equal(officialBody.updatedAt, fullCrawlAt)
      const latestPage = await officialApp.inject({ method: 'GET', url: '/api/clans?limit=4' })
      assert.equal((latestPage.json() as { updatedAt: number | null }).updatedAt, topCrawlAt)
      // An exact tag before a longer one with a better place; bars still measure against the
      // overall leader, not the first match.
      const avSearch = await officialApp.inject({ method: 'GET', url: '/api/clans?query=av' })
      const avBody = avSearch.json() as { leaderRating: number | null; clans: { coreTag: string }[] }
      assert.deepEqual(avBody.clans.map((clan) => clan.coreTag), ['av', 'avr'])
      assert.equal(avBody.leaderRating, 48_400)
      assert.equal(officialBody.leaderRating, 48_400)
      const leader = officialList[0]
      assert.equal(leader?.name, 'AVANGARD')
      assert.equal(leader?.totalRating, 48_400)
      assert.equal(leader?.members, 121)
      assert.equal(leader?.seasonBattles, 2_545)
      assert.equal(leader?.seasonWins, 2_274)
      assert.equal(leader?.avgRating, null, 'без снимков состава средний ПКР неизвестен')
      assert.equal(leader?.lastSeenAt, topCrawlAt)
      // The official value at the crawl nearest a day before the latest one; without a point that
      // old, the season start's (or none), with no known window.
      const expectedDelta24h = hasDayPoints ? 48_400 - 47_000 : leader?.delta24h === null ? null : 48_400 - 40_000
      assert.equal(leader?.delta24h, expectedDelta24h)
      if (!hasDayPoints) assert.equal(leader?.delta24hFrom, null)
      if (hasDayPoints && logStartAt > baseAt) {
        assert.deepEqual([leader?.delta24hFrom, leader?.delta24hTo], [dayAgoAt, topCrawlAt])
        // [LOW] is read by full crawls only: its day starts at the full crawl ~2 h after the mark
        // a day before its own crawl, not at an older point.
        const low = officialList.find((clan) => clan.coreTag === 'low')
        assert.deepEqual([low?.delta24h, low?.delta24hFrom, low?.delta24hTo], [100, dayAgoAt, fullCrawlAt])
      }
      assert.equal(officialList.find((clan) => clan.coreTag === 'tst')?.delta24hFrom, null, 'no point a day before its crawl')
      assert.equal(officialList.find((clan) => clan.coreTag === 'old')?.delta24h, null, 'a dropped squadron has no change')
      const officialTst = officialList.find((clan) => clan.coreTag === 'tst')
      assert.equal(officialTst?.totalRating, 3_000, 'официальный рейтинг заменяет сумму снимков ПКР')
      assert.equal(officialTst?.avgRating, 1_460, 'средний ПКР по снимкам состава сохраняется')

      // The day's battles come from the same point as the rating change. A day ago the table was
      // AVR, OLD, AV (as [AVX]), LOW: [AV] was third and is fourth behind [TST] and [NEW], which had no place
      // then; [OLD], dropped since, still held its place (ranking today's squadrons alone made
      // [AV] lose two).
      const officialAv = officialList.find((clan) => clan.coreTag === 'av')
      assert.equal(leader?.battles24h, hasDayPoints ? 45 : null)
      assert.equal(leader?.wins24h, hasDayPoints ? 34 : null)
      assert.equal(officialAv?.delta24h, hasDayPoints ? -200 : null)
      assert.deepEqual(
        officialList.slice(0, 7).map((clan) => clan.rankChange24h),
        hasDayPoints ? [0, null, null, -1, -1, null, null] : [null, null, null, null, null, null, null],
      )
      // A renamed squadron is one row; its old tag opens it, its old history counts above.
      assert.equal(officialList.some((clan) => clan.coreTag === 'avx'), false)
      if (hasDayPoints) {
        const renamedPage = await officialApp.inject({ method: 'GET', url: '/api/clans/avx' })
        assert.equal((renamedPage.json() as { clan?: { coreTag: string } }).clan?.coreTag, 'av')
      }
      // Playing now: battles that ended within the window, from replays.
      assert.deepEqual(officialList.slice(0, 7).map((clan) => clan.recentBattles), [2, 1, 0, 0, 1, 0, 0])
      assert.deepEqual({ ...officialBody.live, at: 0 }, { count: 3, at: 0, windowSec: 45 * 60 })
      assert.ok((officialBody.live?.at ?? 0) >= nowSec, 'the window ends when the snapshot is built')
      assert.deepEqual(
        officialList.slice(0, 7).map((clan) => clan.aboveRating),
        [null, 48_400, 3_000, 2_800, 2_750, 2_700, null],
      )
      assert.deepEqual(officialBody.tierCutoffs, [{ place: 5, rating: 2_700 }], 'place 10 is not an official squadron')
      // [TST]'s 11 battles are too few for a win rate record; nobody has kills, so no K/D record.
      assert.deepEqual(officialBody.records, {
        winRate: 'avr',
        kd: null,
        battles: 'avr',
        gain: expectedDelta24h === null ? null : 'avr',
      })

      const clanTags = async (query: string): Promise<{ total: number; tags: string[] }> => {
        const response = await officialApp.inject({ method: 'GET', url: `/api/clans?${query}` })
        assert.equal(response.statusCode, 200, query)
        const body = response.json() as ClansBody
        return { total: body.total, tags: body.clans.map((clan) => clan.coreTag) }
      }
      assert.deepEqual(await clanTags('live=true'), { total: 3, tags: ['avr', 'tst', 'low'] })
      assert.deepEqual((await clanTags('sort=battles&limit=3')).tags, ['avr', 'tst', 'new'])
      if (hasDayPoints) {
        assert.deepEqual((await clanTags('sort=change&dir=asc&limit=5')).tags, ['av', 'low', 'avr', 'tst', 'new'])
      }
      // Decorated tags match by their core; a sort replaces the search's own order.
      assert.deepEqual(await clanTags('tags=avr,%5BAV%5D,zzz'), { total: 2, tags: ['avr', 'av'] })
      assert.deepEqual(await clanTags('tags='), { total: 0, tags: [] }, 'an empty favourites list matches nothing')
      assert.deepEqual((await clanTags('query=av&sort=place')).tags, ['avr', 'av'])
      assert.deepEqual(await clanTags('query=av&live=true'), { total: 1, tags: ['avr'] })
      for (const bad of ['sort=rating', 'dir=up', 'live=maybe', 'offset=-1']) {
        const response = await officialApp.inject({ method: 'GET', url: `/api/clans?${bad}` })
        assert.equal(response.statusCode, 400, bad)
      }

      const leaderDetail = await officialApp.inject({ method: 'GET', url: '/api/clans/avr' })
      assert.equal(leaderDetail.statusCode, 200, 'клан лидерборда без снимков ПКР должен открываться')
      const leaderBody = leaderDetail.json() as {
        clan: {
          rank: number; members: number; totalRating: number; seasonBattles: number | null; seasonWins: number | null
          delta30d: number | null
        }
        roster: unknown[]
      }
      assert.equal(leaderBody.clan.rank, 1)
      assert.equal(leaderBody.clan.members, 121)
      assert.equal(leaderBody.clan.totalRating, 48_400)
      assert.equal(leaderBody.clan.seasonBattles, 2_545)
      assert.equal(leaderBody.clan.seasonWins, 2_274)
      assert.equal(leaderBody.clan.delta30d, 48_400 - 40_000, 'the delta is from the official value a month ago')
      assert.equal(leaderBody.roster.length, 0)

      const leaderHistory = await officialApp.inject({ method: 'GET', url: '/api/clans/avr/history?days=90' })
      const leaderPoints = (leaderHistory.json() as { points: { t: number; total: number }[] }).points
      assert.deepEqual(
        leaderPoints.map((point) => point.total),
        [40_000, ...(dayAgoAt > baseAt ? [47_000] : []), 48_307, 48_400],
      )
      assert.equal(leaderPoints[leaderPoints.length - 1]?.t, topCrawlAt)

      const leaderBattles = await officialApp.inject({ method: 'GET', url: '/api/battles?clan=avr' })
      assert.equal(leaderBattles.statusCode, 200)
      const officialStats = await officialApp.inject({ method: 'GET', url: '/api/site-stats' })
      assert.equal((officialStats.json() as { clans: number }).clans, 10, 'the squadron count includes official squadrons')
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
    // The scene cache goes to the real data/battles: remove the fixture's file.
    const sceneHex = BigInt('100200304').toString(16).padStart(16, '0')
    await rm(`./data/battles/${sceneHex}-scene-v${BATTLE_SCENE_VERSION}.json.gz`, { force: true }).catch(() => undefined)
    await app.close()
    await closeWorkerPool()
    closeDb()
  }
}

await main()
