import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { BLK_ORDER, parseBlk, type BlkMap } from '../wrpl/blk.js'
import { unpackVromfs, vromfsBlkNames } from '../wrpl/vromfs.js'
import { decodeDdsxTexture, readDxpPack, unpackDdsxData } from './dxp.js'
import { GameFiles, TACTICAL_MAP_OPTIONAL_SOURCES, TACTICAL_MAP_SOURCES } from './game-files.js'
import { pruneStaleMaps } from './index.js'
import { interpretMission, type MissionOptions } from './mission.js'
import { areaRect, buildTacticalMapModel, gridLabels, gridStep, viewRect, type BlkSource } from './model.js'
import { balanceBucket, balanceBucketRange, balanceLevelOfBr, pickPerspective } from './perspective.js'
import { MAP_SPAWN_KINDS, mapIconNames, mergeSpawns, renderGeometry, tacticalMapOverlaySvg } from './render.js'
import { buildBattleScene, sceneAir, sceneAirView } from '../wrpl/battle-scene-core.js'
import type { ReplayEvents } from '../wrpl/replay-events.js'
import { oodleDecompress } from './oodle.js'

/** An Oodle stream of one stored block: restart + uncompressed header, decoder type, raw bytes. */
const storedOodle = (data: Uint8Array, type = 0x0c): Buffer => Buffer.concat([Buffer.from([0xcc, type]), data])

test('Oodle decodes stored blocks and rejects malformed streams', () => {
  const data = Buffer.from('tactical map '.repeat(20))
  for (const type of [0x06, 0x0a, 0x0c]) assert.deepEqual(oodleDecompress(storedOodle(data, type), data.length), data)
  assert.throws(() => oodleDecompress(Buffer.from([0x8c, 0x0c, 1, 2, 3]), 64), /malformed stream/)
  assert.throws(() => oodleDecompress(storedOodle(data), data.length + 1), /malformed stream/)
  assert.throws(() => oodleDecompress(data, 0), /invalid output size/)
})

function uleb(value: number): number[] {
  const out: number[] = []
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    out.push(byte)
  } while (value > 0)
  return out
}

interface PackTexture { name: string; format: 'DXT1' | 'DXT5'; width: number; height: number; levels: number; flags: number; data: Buffer }

/** A DxP2 v2 pack as the game writes it; texture data follows the dump. */
function dxpPack(textures: PackTexture[]): Buffer {
  const count = textures.length
  const namesAt = 48
  const nameBytes = textures.map((t) => Buffer.from(`${t.name}*?acq0-0-0\0`))
  const stringsAt = namesAt + count * 8
  const headersAt = stringsAt + nameBytes.reduce((n, b) => n + b.length, 0) + 4
  const recordsAt = headersAt + count * 32
  const dumpSize = recordsAt + count * 24
  const head = Buffer.alloc(16 + dumpSize)
  head.write('DxP2', 0, 'latin1')
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(count, 8)
  head.writeUInt32LE(dumpSize, 12)
  const table = (at: number, offset: number): void => {
    head.writeUInt32LE(offset, 16 + at)
    head.writeUInt32LE(count, 16 + at + 4)
  }
  table(0, namesAt)
  table(16, headersAt)
  table(32, recordsAt)
  let s = stringsAt
  let dataAt = head.length
  const blobs: Buffer[] = []
  textures.forEach((t, i) => {
    head.writeBigUInt64LE(BigInt(s), 16 + namesAt + i * 8)
    nameBytes[i]!.copy(head, 16 + s)
    s += nameBytes[i]!.length
    const packed = storedOodle(t.data)
    const h = 16 + headersAt + i * 32
    head.write('DDSx', h, 'latin1')
    head.write(t.format, h + 4, 'latin1')
    head.writeUInt32LE(t.flags >>> 0, h + 8)
    head.writeUInt16LE(t.width, h + 12)
    head.writeUInt16LE(t.height, h + 14)
    head[h + 16] = t.levels
    head.writeUInt32LE(t.data.length, h + 24)
    head.writeUInt32LE(packed.length, h + 28)
    const r = 16 + recordsAt + i * 24
    head.writeInt32LE(-1, r + 8)
    head.writeUInt32LE(dataAt, r + 12)
    head.writeUInt32LE(packed.length, r + 16)
    blobs.push(packed)
    dataAt += packed.length
  })
  return Buffer.concat([head, ...blobs])
}

/** One DXT1 block: colour 0 everywhere (index 0). */
const dxt1Block = (rgb565: number): Buffer => Buffer.from([rgb565 & 0xff, rgb565 >> 8, 0, 0, 0, 0, 0, 0])

test('DxP2 packs: Oodle DDSx, DXT1, DXT5 alpha and the reversed mip order', () => {
  const OODLE = 0x60000000
  const REV_MIPS = 0x00040000
  const red = 0xf800
  const blue = 0x001f
  // 8×8 DXT1: 4 blocks; reversed mips: the 4×4 level (one block) comes first.
  const big = Buffer.concat([dxt1Block(red), dxt1Block(red), dxt1Block(red), dxt1Block(red)])
  const small = dxt1Block(blue)
  // DXT5 4×4: alpha endpoints 255/0, every alpha index 1 (alpha 0), colour white.
  const dxt5 = Buffer.from([255, 0, 0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
  const file = dxpPack([
    { name: 'test_tankmap', format: 'DXT1', width: 8, height: 8, levels: 2, flags: OODLE | REV_MIPS, data: Buffer.concat([small, big]) },
    { name: 'test_alpha', format: 'DXT5', width: 4, height: 4, levels: 1, flags: OODLE, data: dxt5 },
  ])
  const pack = readDxpPack(file)
  assert.deepEqual([...pack.keys()], ['test_tankmap', 'test_alpha'])
  const decode = (name: string) => {
    const entry = pack.get(name)!
    return decodeDdsxTexture(entry.header, unpackDdsxData(entry.header, file.subarray(entry.offset, entry.offset + entry.size)))
  }
  const map = decode('test_tankmap')
  assert.equal(map.width, 8)
  assert.deepEqual([...map.data.subarray(0, 4)], [255, 0, 0, 255])
  assert.deepEqual([...map.data.subarray(map.data.length - 4)], [255, 0, 0, 255])
  const alpha = decode('test_alpha')
  assert.deepEqual([...alpha.data.subarray(0, 4)], [255, 255, 255, 0])
  // A record pointing past the end is refused.
  assert.throws(() => readDxpPack(file.subarray(0, file.length - 4)), /out of bounds/)
})

/** A plain VRFs archive with the given files (the last one may be the shared name map). */
function vromfs(files: { name: string; data: Buffer }[]): Buffer {
  const count = files.length
  const nameTable = 32
  const namesAt = nameTable + count * 8
  const names = Buffer.from(files.map((f) => `${f.name}\0`).join(''), 'latin1')
  const dataTable = namesAt + names.length + (16 - ((namesAt + names.length) % 16))
  let at = dataTable + count * 16
  const image = Buffer.alloc(at + files.reduce((n, f) => n + f.data.length, 0))
  image.writeUInt32LE(nameTable, 0)
  image.writeUInt32LE(count, 4)
  image.writeUInt32LE(dataTable, 16)
  image.writeBigUInt64LE(BigInt(namesAt), nameTable)
  names.copy(image, namesAt)
  files.forEach((f, i) => {
    image.writeUInt32LE(at, dataTable + i * 16)
    image.writeUInt32LE(f.data.length, dataTable + i * 16 + 4)
    f.data.copy(image, at)
    at += f.data.length
  })
  const header = Buffer.alloc(16)
  header.write('VRFs', 0, 'latin1')
  header.write('\0\0PC', 4, 'latin1')
  header.writeUInt32LE(image.length, 8)
  header.writeUInt32LE(0x80000000, 12)
  return Buffer.concat([header, image])
}

/** A slim BLK body over shared names: params as [name, kind, value], one child block. */
function slimBlk(shared: string[], root: [string, 'str' | 'p2', string | [number, number]][], child: [string, [string, 'str', string][]]): Buffer {
  const data: number[] = []
  const params: number[] = []
  const nameId = (name: string): number => {
    const id = shared.indexOf(name)
    if (id < 0) throw new Error(`no shared name ${name}`)
    return id
  }
  const put = (name: string, kind: 'str' | 'p2', value: string | [number, number]): void => {
    const offset = data.length
    if (kind === 'str') data.push(...Buffer.from(`${value as string}\0`))
    else {
      const b = Buffer.alloc(8)
      b.writeFloatLE((value as [number, number])[0], 0)
      b.writeFloatLE((value as [number, number])[1], 4)
      data.push(...b)
    }
    const p = Buffer.alloc(8)
    p.writeUInt32LE((nameId(name) | ((kind === 'str' ? 1 : 4) << 24)) >>> 0, 0)
    p.writeUInt32LE(offset, 4)
    params.push(...p)
  }
  for (const [name, kind, value] of root) put(name, kind, value)
  for (const [name, kind, value] of child[1]) put(name, kind, value)
  return Buffer.from([
    0x03,
    ...uleb(0), // no names of its own
    ...uleb(2), ...uleb(root.length + child[1].length), ...uleb(data.length), ...data, ...params,
    ...uleb(0), ...uleb(root.length), ...uleb(1), ...uleb(1),
    ...uleb(nameId(child[0]) + 1), ...uleb(child[1].length), ...uleb(0),
  ])
}

test('VROMFS shared name map decodes slim BLKs, repeated vector keys stay separate', () => {
  const shared = ['level', 'tankGridSteps', 'mission', 'name']
  const list = Buffer.from([...uleb(shared.length), ...uleb(shared.join('\0').length + 1), ...Buffer.from(`${shared.join('\0')}\0`)])
  const nameMap = Buffer.concat([Buffer.alloc(40), zstdCompressSync(list)])
  const blk = slimBlk(shared, [['level', 'str', 'levels/test.bin'], ['tankGridSteps', 'p2', [256, 256]], ['tankGridSteps', 'p2', [130, 130]]], ['mission', [['name', 'str', 'dom']]])
  const packed = Buffer.concat([Buffer.from([0x04]), zstdCompressSync(blk.subarray(1))])
  const files = unpackVromfs(vromfs([
    { name: 'levels/test.blk', data: blk },
    { name: 'levels/packed.blk', data: packed },
    { name: '\xff?nm', data: nameMap },
  ]))
  const names = vromfsBlkNames(files)
  assert.deepEqual(names?.names, shared)
  const expected = { level: 'levels/test.bin', tankGridSteps: [[256, 256], [130, 130]], mission: { name: 'dom' } }
  assert.deepEqual(parseBlk(files[0]!.data, names), expected)
  assert.deepEqual(parseBlk(files[1]!.data, names), expected)
  // The stored order: params, then child blocks, a repeated key once per occurrence.
  assert.deepEqual(parseBlk(files[0]!.data, names)[BLK_ORDER], ['level', 'tankGridSteps', 'tankGridSteps', 'mission'])
  assert.throws(() => parseBlk(files[0]!.data), /shared name map/)
})

/** A mission file in the shape of the game's dom_template flow. */
function domMission(): Map<string, BlkMap> {
  const box = (x: number, z: number, size: number): BlkMap => ({ type: 'Box', tm: [[size, 0, 0], [0, 100, 0], [0, 0, size], [x, 0, z]] })
  const zone = (x: number, z: number): BlkMap => ({ type: 'Cylinder', tm: [[40, 0, 0], [0, 50, 0], [0, 0, 40], [x, 0, z]] })
  const spawn = (x: number, z: number): BlkMap => ({ type: 'Sphere', tm: [[5, 0, 0], [0, 5, 0], [0, 0, 5], [x, 0, z]] })
  const respawn = (target: string, team: string): BlkMap => ({ target, team, showOnMap: true, tags: { tank: true } })
  const template: BlkMap = {
    variables: { battle_area_name: '', zone_name: '', t1: '', t2: '' },
    triggers: {
      dom_init: {
        is_enabled: true,
        events: { initMission: {} },
        actions: {
          varSetString: [
            { value: 'dom_battle_area', var: 'battle_area_name' },
            { value: 'dom_capture_area_01', var: 'zone_name' },
            { value: 'dom_t1_spawn', var: 't1' },
            { value: 'dom_t2_spawn', var: 't2' },
          ],
          triggerEnable: { target: ['dom_check_realistic'] },
        },
      },
      dom_check_realistic: {
        is_enabled: false,
        events: { initMission: {} },
        conditions: { gameWhenDifficulty: { difficulty: 'realistic', is: 'equal' }, objectExists: { target: 'dom_battle_area_realistic', type: 'area' } },
        actions: { varAddString: { value: '_realistic', var: ['battle_area_name', 'zone_name', 't1', 't2'] }, triggerEnable: { target: 'dom_start' } },
        else_actions: { varAddString: { value: '_arcade', var: ['battle_area_name', 'zone_name', 't1', 't2'] }, triggerEnable: { target: 'dom_start' } },
      },
      dom_start: {
        is_enabled: false,
        events: { initMission: {} },
        actions: {
          missionBattleArea: { area: '@battle_area_name', mapArea: true, ground: true, newGridHorizontalCellCount: 0 },
          missionMarkAsCaptureZone: { target: '@zone_name' },
          missionMarkAsRespawnPoint: [respawn('@t1', 'A'), respawn('@t2', 'B')],
        },
      },
    },
  }
  const mission: BlkMap = {
    mission_settings: { mission: { level: 'levels/avg_test.bin', type: 'domination', postfix: '_Dom', useAlternativeMapCoord: true, mission: [{ difficulty: 'realistic', useAlternativeMapCoord: false }] } },
    imports: { import_record: [{ file: 'gameData/missions/templates/dom_template.blk', importAreas: true, importUnits: true, importTriggers: true }] },
    areas: {
      dom_battle_area_arcade: box(1000, 2000, 1400),
      dom_capture_area_01_arcade: zone(900, 2100),
      dom_t1_spawn_arcade_01: spawn(500, 1500),
      dom_t1_spawn_arcade_02: spawn(520, 1500),
      dom_t2_spawn_arcade_01: spawn(1500, 2500),
    },
    units: {
      area_squad: [
        { name: 'dom_t1_spawn_arcade', tm: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [510, 0, 1500]], props: { squad_members: ['dom_t1_spawn_arcade_01', 'dom_t1_spawn_arcade_02'] } },
        { name: 'dom_t2_spawn_arcade', tm: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1500, 0, 2500]], props: { squad_members: 'dom_t2_spawn_arcade_01' } },
      ],
    },
  }
  return new Map([
    ['gamedata/missions/cta/tanks/test/test_dom.blk', mission],
    ['gamedata/missions/templates/dom_template.blk', template],
  ])
}

test('mission triggers: the realistic check falls back to the arcade objects', () => {
  const files = domMission()
  const map = interpretMission('gamedata/missions/cta/tanks/test/test_dom.blk', (rel) => files.get(rel) ?? null, 'realistic')
  assert.equal(map.level, 'levels/avg_test.bin')
  assert.equal(map.settings['useAlternativeMapCoord'], false)
  assert.deepEqual(map.battleAreas.map((area) => [area.area.name, area.mapArea]), [['dom_battle_area_arcade', true]])
  assert.deepEqual(map.captureZones.map((zone) => [zone.area.name, zone.index]), [['dom_capture_area_01_arcade', 0]])
  assert.deepEqual(map.respawnBases.map((base) => [base.name, base.team, base.areas.length]), [['dom_t1_spawn_arcade', 'A', 2], ['dom_t2_spawn_arcade', 'B', 1]])
  // Arcade keeps the mission-wide setting.
  const arcade = interpretMission('gamedata/missions/cta/tanks/test/test_dom.blk', (rel) => files.get(rel) ?? null, 'arcade')
  assert.equal(arcade.settings['useAlternativeMapCoord'], true)
})

test('map grid: area extents, step tables, the view moved inside the texture, labels', () => {
  const box = areaRect({ name: 'b', type: 'Box', tm: [[-1300, 0, 0], [0, 100, 0], [0, 0, -1300], [2498.6, 42, 1139.7]] })
  assert.ok(Math.abs(box.x0 - 1848.6) < 1e-9 && Math.abs(box.z1 - 1789.7) < 1e-9)
  const cylinder = areaRect({ name: 'c', type: 'Cylinder', tm: [[850, 0, 0], [0, 10, 0], [0, 0, 850], [1036, 42, 1054]] })
  assert.equal(cylinder.x1 - cylinder.x0, 1700)
  // The 158 snapshots: 1300 m → 180, 1400 → 200, krymsk's level grid 1680 → 225, the 8111 air map 65536 → 6500.
  assert.equal(gridStep(1300, 1300, 0, 204), 180)
  assert.equal(gridStep(1400, 1400, 0, 205), 200)
  assert.equal(gridStep(1680, 1680, 0, 130), 225)
  assert.equal(gridStep(65536, 65536, 0, 3250), 6500)
  assert.equal(gridStep(1400, 1400, 0, 1), 1, 'a level without tankGridSteps keeps no grid')
  assert.equal(gridStep(1400, 1400, 5, 205), 280, 'newGridHorizontalCellCount')
  // berlin_conq1: the 1300 m area overhangs tankMapCoord1.x 3072 by 76.6 m; the view moves, the grid stays.
  const grid = { zeroX: box.x0, zeroZ: box.z1, sizeX: 1300, sizeZ: 1300, step: 180 }
  const view = viewRect(grid, { x0: 1024, z0: 0, x1: 3072, z1: 2048 })
  assert.ok(Math.abs(view.x0 - 1772) < 1e-6 && Math.abs(view.x1 - 3072) < 1e-6 && Math.abs(view.z1 - box.z1) < 1e-6)
  const { columns, rows } = gridLabels({ grid, view })
  assert.deepEqual(columns.map((c) => c.label), ['1', '2', '3', '4', '5', '6', '7'])
  // "1" sits in the first lattice cell whose centre is inside the view: 1848.6 + 90 m, at 148 px of 1153.
  assert.ok(Math.abs(((columns[0]!.x - view.x0) / 1300) * 1153 - 148) < 1)
  assert.deepEqual(rows.map((r) => r.label), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  // alaska_town_dom: 1500 m at 200 m — the eighth cell's centre lies on the edge and gets no label.
  const alaska = { zeroX: 0, zeroZ: 1500, sizeX: 1500, sizeZ: 1500, step: 200 }
  const alaskaLabels = gridLabels({ grid: alaska, view: { x0: 0, z0: 0, x1: 1500, z1: 1500 } })
  assert.equal(alaskaLabels.columns.length, 7)
  assert.equal(alaskaLabels.rows.length, 7)
})

test('respawn areas merge within 200 m per team and kind; the icon sits at the mean', () => {
  const spawns = [
    { team: 'A' as const, kind: 'tank' as const, x: 0, z: 0 },
    { team: 'A' as const, kind: 'tank' as const, x: 150, z: 0 },
    { team: 'A' as const, kind: 'tank' as const, x: 300, z: 0 },
    { team: 'B' as const, kind: 'tank' as const, x: 100, z: 0 },
    { team: 'A' as const, kind: 'fighter' as const, x: 50, z: 0 },
  ]
  assert.deepEqual(mergeSpawns(spawns).map((s) => [s.team, s.kind, s.x]), [['A', 'tank', 150], ['B', 'tank', 100], ['A', 'fighter', 50]])
  // Aircraft bases merge within 2 km (minDistBetweenZonesOnAircraftRespawnBases), tanks 1.5 km apart do not.
  const apart = [
    { team: 'A' as const, kind: 'fighter' as const, x: 0, z: 0 },
    { team: 'A' as const, kind: 'fighter' as const, x: 1500, z: 0 },
    { team: 'A' as const, kind: 'tank' as const, x: 0, z: 5000 },
    { team: 'A' as const, kind: 'tank' as const, x: 1500, z: 5000 },
  ]
  assert.deepEqual(mergeSpawns(apart).map((s) => [s.kind, s.x]), [['fighter', 750], ['tank', 0], ['tank', 1500]])
})

test('mission triggers fire depth first: each rank check marks its own air spawn', () => {
  const sphere = (x: number): BlkMap => ({ type: 'Sphere', tm: [[10, 0, 0], [0, 10, 0], [0, 0, 10], [x, 0, 0]] })
  const check = (name: string, min: number, value: string, marker: string): [string, BlkMap] => [name, {
    is_enabled: false,
    events: { initMission: {} },
    conditions: { varCompareInt: { var_value: 'session_rank', value: min, comparasion_func: 'notLess' } },
    actions: { varSetString: { value, var: 't1_air' }, triggerEnable: { target: marker } },
  }]
  const marker = (name: string): [string, BlkMap] => [name, {
    is_enabled: false,
    events: { initMission: {} },
    actions: { missionMarkAsRespawnPoint: { target: '@t1_air', team: 'A', showOnMap: true, tags: {} } },
  }]
  const mission: BlkMap = {
    mission_settings: { mission: { level: 'levels/avg_test.bin' } },
    variables: { session_rank: 0, t1_air: '' },
    areas: { air_hardcore: sphere(-5000), air_top: sphere(-9000) },
    triggers: Object.fromEntries([
      ['init', { is_enabled: true, events: { initMission: {} }, actions: { missionGetBalanceLevel: { input_var: 'session_rank' }, triggerEnable: { target: ['high', 'top'] } } }],
      check('high', 20, 'air_hardcore', 'mark_high'),
      check('top', 32, 'air_top', 'mark_top'),
      marker('mark_high'),
      marker('mark_top'),
    ]),
  }
  const names = (rank: number) => interpretMission('m.blk', () => mission, { balanceLevel: rank }).respawnBases.map((base) => base.name)
  assert.deepEqual(names(10), [])
  assert.deepEqual(names(25), ['air_hardcore'])
  assert.deepEqual(names(33), ['air_hardcore', 'air_top'])
})

/** air_spawn_template's forced airfield spawn and the conditional imports of a squadron mission, in miniature. */
function squadronMission(): Map<string, BlkMap> {
  const sphere = (x: number): BlkMap => ({ type: 'Sphere', tm: [[10, 0, 0], [0, 10, 0], [0, 0, 10], [x, 0, 0]] })
  const record = (file: string, condition: BlkMap = {}): BlkMap => ({ file, importAreas: true, importUnits: true, importTriggers: true, ...condition })
  const airfield = (x: number): BlkMap => ({ units: { objectGroups: { name: 't1_airfield', tm: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [x, 0, 0]] } } })
  const mission: BlkMap = {
    mission_settings: { mission: { level: 'levels/avg_test.bin' } },
    imports: { import_record: [
      record('low.blk', { rankRange: [0, 20] }),
      record('mid.blk', { rankRange: [21, 50] }),
      record('area.blk', { difficulty: 'arcade' }),
      record('area_rb.blk', { difficulty: 'realistic' }),
      record('area.blk', { difficulty: 'hardcore' }),
      record('ww.blk', { importByParameter: 'isWorldWar' }),
    ] },
    variables: { forced: false },
    areas: { t1_air_spawn_hardcore: sphere(-9000), t1_bombers_spawn_arcade: sphere(-3000) },
    triggers: {
      init: {
        is_enabled: true,
        events: { initMission: {} },
        actions: {
          varSetBool: { value: false, var: 'forced', fromDescriptor: 'force_plane_airfield_spawn' },
          missionBattleArea: [{ area: 'battle_area', team: 'Both', mapArea: true }, { area: 'at_gun', team: 'Both', mapArea: true }],
          triggerEnable: { target: 'spawn' },
        },
      },
      spawn: {
        is_enabled: false,
        events: { initMission: {} },
        conditions: { varCompareBool: { var_value: 'forced', value: false, comparasion_func: 'equal' } },
        actions: { missionMarkAsRespawnPoint: { target: 't1_air_spawn_hardcore', team: 'A', showOnMap: true, tags: {} } },
        else_actions: { missionMarkAsRespawnPoint: [
          { target: 't1_bombers_spawn_arcade', team: 'A', showOnMap: true, tags: { type_longrange_bomber: true } },
          { target: 't1_airfield', team: 'A', isAirfield: true, showOnMap: true, tags: {} },
        ] },
      },
    },
  }
  return new Map([
    ['m.blk', mission],
    ['low.blk', airfield(1000)],
    ['mid.blk', airfield(5000)],
    ['area.blk', { areas: { battle_area: sphere(100) } }],
    ['area_rb.blk', { areas: { battle_area: sphere(200) } }],
    ['ww.blk', { areas: { at_gun: sphere(300) } }],
  ])
}

test('mission imports load by rank range, difficulty and parameter; fromDescriptor takes the session value', () => {
  const files = squadronMission()
  const run = (options: MissionOptions) => interpretMission('m.blk', (rel) => files.get(rel) ?? null, options)
  const bases = (options: MissionOptions) => run(options).respawnBases.map((base) => [base.name, base.areas[0]!.tm[3][0]])
  const areas = (options: MissionOptions) => run(options).battleAreas.map((area) => [area.area.name, area.area.tm[3][0]])
  const squadron = { force_plane_airfield_spawn: true }
  assert.deepEqual(bases({ balanceLevel: 20 }), [['t1_air_spawn_hardcore', -9000]], 'without a descriptor the file value holds')
  assert.deepEqual(bases({ balanceLevel: 20, descriptor: squadron }), [['t1_bombers_spawn_arcade', -3000], ['t1_airfield', 1000]])
  assert.deepEqual(bases({ balanceLevel: 21, descriptor: squadron }), [['t1_bombers_spawn_arcade', -3000], ['t1_airfield', 5000]], 'rankRange is inclusive')
  assert.deepEqual(areas({}), [['battle_area', 200]], 'realistic')
  assert.deepEqual(areas({ difficulty: 'arcade' }), [['battle_area', 100]])
  assert.deepEqual(areas({ difficulty: 'simulator' }), [['battle_area', 100]], 'a skipped import leaves its file to a later one')
  assert.deepEqual(areas({ descriptor: { isWorldWar: true } }), [['battle_area', 200], ['at_gun', 300]])
  assert.deepEqual(areas({ descriptor: { isWorldWar: 1 } }), [['battle_area', 200]], 'only true loads it')
})

test('a map build deletes only its mission\'s files of another hash', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wtbot-maps-'))
  try {
    const names = [
      'poland_dom-A-r21-1400-aaaaaaaaaaaa.jpg', 'poland_dom-A-r21-1400-aaaaaaaaaaaa.json', 'poland_dom-air-r26-aaaaaaaaaaaa.json',
      'poland_dom-B-r20-2800-bbbbbbbbbbbb.jpg', 'poland_dom-air-r32-bbbbbbbbbbbb.json',
      'poland_02_dom-A-r20-1400-bbbbbbbbbbbb.jpg', 'poland_dom-A-r21-1400-bbbbbbbbbbbb.jpg.123.tmp',
    ]
    for (const name of names) writeFileSync(path.join(dir, name), '')
    mkdirSync(path.join(dir, 'export'))
    await pruneStaleMaps('gamedata/missions/cta/tanks/poland/poland_dom.blk', 'aaaaaaaaaaaa', dir)
    assert.deepEqual(readdirSync(dir).sort(), [
      'export', 'poland_02_dom-A-r20-1400-bbbbbbbbbbbb.jpg',
      'poland_dom-A-r21-1400-aaaaaaaaaaaa.jpg', 'poland_dom-A-r21-1400-aaaaaaaaaaaa.json', 'poland_dom-A-r21-1400-bbbbbbbbbbbb.jpg.123.tmp',
      'poland_dom-air-r26-aaaaaaaaaaaa.json',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('perspective: the side whose bases are nearest to a team\'s first positions; ranks from the BR cap', () => {
  const map = { spawns: [
    { team: 'A' as const, kind: 'tank', x: 0, z: 0 },
    { team: 'B' as const, kind: 'tank', x: 1000, z: 1000 },
    { team: 'A' as const, kind: 'fighter', x: 990, z: 990 },
  ] }
  assert.equal(pickPerspective(map, [{ x: 950, z: 980 }, { x: 1020, z: 1010 }, { x: 30, z: 10 }]), 'B')
  assert.equal(pickPerspective(map, [{ x: 10, z: 0 }]), 'A')
  assert.equal(pickPerspective(map, [{ x: 0, z: 0 }, { x: 1000, z: 1000 }]), null, 'a tie')
  assert.equal(pickPerspective({ spawns: [] }, [{ x: 0, z: 0 }]), null)
  // Squadron stage caps: 14.7 → 41, 12.0 → 33, 10.7 → 29, 7.3 → 19.
  assert.deepEqual([14.7, 12.0, 10.7, 7.3].map(balanceLevelOfBr), [41, 33, 29, 19])
  // Buckets start where the maps change: helipads 20, mid-rank airfields 21, UCAV 26.
  assert.deepEqual([41, 26, 25, 21, 20, 19, 0].map(balanceBucket), [26, 26, 21, 21, 20, 0, 0])
  assert.deepEqual([41, 23, 20, 7].map(balanceBucketRange), [[26, 50], [21, 25], [20, 20], [0, 19]])
})

test('the battle scene names the map perspective in which team 1 starts on the blue bases', () => {
  const events = {
    endTime: 60_000,
    units: [
      { userId: 'p1', model: 'tankModels/t', source: 'ground', path: [{ t: 0, x: 990, z: 1000 }, { t: 1000, x: 900, z: 900 }] },
      { userId: 'p2', model: 'tankModels/t', source: 'ground', path: [{ t: 0, x: 10, z: 5 }, { t: 1000, x: 100, z: 100 }] },
    ],
    kills: [],
    zones: [],
  } as unknown as ReplayEvents
  const input = {
    sessionId: '1', missionName: 'm', gameMode: null, startTime: 0, durationSec: 60, teamWon: 1,
    missionArea: { x0: 0, z0: 0, x1: 1000, z1: 1000 }, mapAvailable: true, level: 'levels/avg_test.bin',
    players: [{ userId: 'p1', nick: 'a', team: 1, clanTag: null }, { userId: 'p2', nick: 'b', team: 2, clanTag: null }],
    botSlots: [],
    mapSpawns: [{ team: 'A' as const, kind: 'tank', x: 0, z: 0 }, { team: 'B' as const, kind: 'tank', x: 1000, z: 1000 }],
  }
  assert.deepEqual(buildBattleScene(events, input).map, { available: true, level: 'levels/avg_test.bin', team: 'B' })
  assert.deepEqual(buildBattleScene(events, { ...input, mapSpawns: null }).map, { available: true, level: 'levels/avg_test.bin' })
})

/** air_spawn_template's helipad and UCAV logic in miniature: object groups, var_value_other, file-order actions. */
function heliMission(): BlkMap {
  const ucavNear: BlkMap = {
    is_enabled: false,
    events: { initMission: {} },
    conditions: { objectExists: [{ target: 't1_helipad', type: 'objectGroup' }, { target: 't2_helipad', type: 'objectGroup' }] },
    actions: {
      duplicateAreaAtPos: [
        { area: 'spawn_ucav', target: 't1_helipad', var_out: 'ucav_spawn_name', posOffset: [6000, 3000, 0], spawnOffsetSpace: 'object' },
        { area: 'spawn_ucav', target: 't2_helipad', var_out: 'ucav_spawn_name', posOffset: [6000, 3000, 0], spawnOffsetSpace: 'object' },
      ],
      missionMarkAsRespawnPoint: [
        { target: '@ucav_spawn_name', team: 'A', showOnMap: true, tags: { type_strike_ucav: true, helicopter: false } },
        { target: '@ucav_spawn_name', team: 'B', showOnMap: true, tags: { type_strike_ucav: true, helicopter: false } },
      ],
    },
  }
  // The file alternates them; the parser keeps that order in BLK_ORDER.
  Object.defineProperty(ucavNear['actions'], BLK_ORDER, { value: ['duplicateAreaAtPos', 'missionMarkAsRespawnPoint', 'duplicateAreaAtPos', 'missionMarkAsRespawnPoint'] })
  const heliTags = { helicopter: true, type_attack_helicopter: true, tank: false }
  return {
    mission_settings: { mission: { level: 'levels/avg_test.bin' } },
    variables: { session_rank: 0, ucav_min_mrank: 0, ucav_spawn_name: '' },
    areas: { spawn_ucav: { type: 'Sphere', tm: [[20, 0, 0], [0, 20, 0], [0, 0, 20], [0, 0, 0]] } },
    units: {
      objectGroups: [
        // t1 faces north (local x = world +z), t2 faces west.
        { name: 't1_helipad', tm: [[0, 0, 1], [0, 1, 0], [-1, 0, 0], [1000, 50, 2000]] },
        { name: 't2_helipad', tm: [[-1, 0, 0], [0, 1, 0], [0, 0, -1], [-4000, 20, 0]] },
      ],
    },
    triggers: {
      init: {
        is_enabled: true,
        events: { initMission: {} },
        actions: {
          missionGetBalanceLevel: { input_var: 'session_rank' },
          varSetInt: { value: 26, var: 'ucav_min_mrank' },
          triggerEnable: { target: ['helipads', 'ucav_check'] },
        },
      },
      helipads: {
        is_enabled: false,
        events: { initMission: {} },
        conditions: { objectExists: [{ target: 't1_helipad', type: 'objectGroup' }, { target: 't2_helipad', type: 'objectGroup' }] },
        actions: {
          missionMarkAsRespawnPoint: [
            { target: 't1_helipad', team: 'A', isAirfield: true, showOnMap: true, tags: heliTags },
            { target: 't2_helipad', team: 'B', isAirfield: true, showOnMap: true, tags: heliTags },
          ],
        },
      },
      ucav_check: {
        is_enabled: false,
        events: { initMission: {} },
        conditions: { varCompareInt: { var_value: 'session_rank', value: 0, comparasion_func: 'notLess', var_value_other: 'ucav_min_mrank' } },
        actions: { triggerEnable: { target: 'ucav_near' } },
      },
      ucav_near: ucavNear,
    },
  }
}

test('mission triggers: helipads on object groups, UCAV spawns duplicated ahead of them in file order', () => {
  const mission = heliMission()
  const bases = (rank: number) => interpretMission('m.blk', () => mission, { balanceLevel: rank }).respawnBases
    .map((base) => [base.name, base.team, base.isAirfield, Math.round(base.areas[0]!.tm[3][0]!), Math.round(base.areas[0]!.tm[3][2]!)])
  assert.deepEqual(bases(25), [['t1_helipad', 'A', true, 1000, 2000], ['t2_helipad', 'B', true, -4000, 0]], 'below ucav_min_mrank 26: no UCAV')
  const top = bases(30)
  // 6 km along each helipad's own x axis: t1 north of it, t2 west of it.
  assert.deepEqual(top.slice(2).map((base) => base.slice(1)), [['A', false, 1000, 8000], ['B', false, -10000, 0]])
})

/** A level and mission source for the model: an air map of 65 536 m, a 4 096 m tank map. */
function airSource(level: BlkMap): BlkSource {
  return (archive, name) => (archive === 'mis.vromfs.bin' ? (name === 'm.blk' ? heliMission() : null) : name === 'levels/avg_test.blk' ? level : null)
}

test('the air map: mapCoord frame, the level grid over the whole rect, every base kind', () => {
  const level: BlkMap = {
    mapCoord0: [-32768, -32768],
    mapCoord1: [32768, 32768],
    gridSteps: [2048, 2048],
    customLevelMap: 'test_air_map*',
    mapColorMult: [200, 220, 240, 255],
    tankMapCoord0: [0, 0],
    tankMapCoord1: [4096, 4096],
    tankGridSteps: [410, 410],
  }
  const air = buildTacticalMapModel('m.blk', airSource(level), { kind: 'air', balanceLevel: 30 })
  assert.equal(air.texture.name, 'test_air_map')
  assert.deepEqual(air.texture.colorMult, [240, 220, 200, 255], 'E3DCOLOR bytes are B, G, R, A')
  assert.deepEqual(air.view, { x0: -32768, z0: -32768, x1: 32768, z1: 32768 })
  assert.deepEqual([air.grid.zeroX, air.grid.zeroZ, air.grid.step], [-32768, 32768, 6500])
  assert.deepEqual([...new Set(air.spawns.map((spawn) => spawn.kind))], ['helicopter', 'ucav'])
  const tank = buildTacticalMapModel('m.blk', airSource(level), { kind: 'tank', balanceLevel: 30 })
  assert.equal(tank.texture.name, 'avg_test_tankmap')
  assert.deepEqual([tank.grid.zeroX, tank.grid.zeroZ, tank.grid.step], [0, 4096, 550], 'floor(4096 / (7 · 50)) · 50')
  // A gridZeroPoint at or below the rect's south edge falls back to the north-west corner.
  const low = buildTacticalMapModel('m.blk', airSource({ ...level, gridZeroPoint: [0, -32768] }), { kind: 'air' })
  assert.deepEqual([low.grid.zeroX, low.grid.zeroZ], [-32768, 32768])
})

test('a crop of a map keeps the whole map\'s cell names and draws its icons at UI size', () => {
  const grid = { zeroX: -32768, zeroZ: 32768, step: 6500 }
  const view = { x0: -32768, z0: -32768, x1: 32768, z1: 32768 }
  const crop = { x0: -20000, z0: 0, x1: -7000, z1: 13000 }
  const { columns, rows } = gridLabels({ grid, view }, crop)
  assert.deepEqual(columns.map((c) => c.label), ['3', '4'])
  assert.deepEqual(rows.map((r) => r.label), ['d', 'e'])
  // Cells outside the map's view get no label.
  const beyond = gridLabels({ grid, view }, { x0: -40000, z0: 20000, x1: -27000, z1: 33000 })
  assert.deepEqual(beyond.columns.map((c) => c.label), ['1'])
  const icon = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><style>.cls-1{fill:${fill}}</style><path class="cls-1" id="a" d="M0 0h36v36z"/></svg>`
  const icons = { get: (name: string) => (name.startsWith('objective_') ? icon('#fff') : undefined) }
  const spec = {
    grid,
    view,
    zones: [{ letter: 'A', x: -10000, z: 5000, radius: 50 }],
    spawns: [
      { team: 'A' as const, kind: 'helicopter' as const, x: -15000, z: 6000 },
      { team: 'B' as const, kind: 'airfield' as const, x: -12000, z: 4000 },
      { team: 'B' as const, kind: 'tank' as const, x: -11000, z: 4000 },
    ],
    showCellSize: true,
  }
  const svg = tacticalMapOverlaySvg(spec, renderGeometry({ view: crop }, 1400), null, icons, { team: 'A', kinds: MAP_SPAWN_KINDS.air, zones: false })
  assert.match(svg, /class="objective_helicopter-cls-1"/)
  assert.match(svg, /\.objective_helicopter-cls-1\{/)
  assert.match(svg, /id="objective_airfield-a"/)
  assert.match(svg, /filter="url\(#tint-054afb\)"/, 'the own helicopter in the own colour')
  assert.doesNotMatch(svg, /basezone_small_mark/, 'zones: false')
  assert.match(svg, />6500 m</)
  // The tank map draws tank bases only.
  const tankSvg = tacticalMapOverlaySvg(spec, renderGeometry({ view: crop }, 1400), null, icons, { team: 'A' })
  assert.doesNotMatch(tankSvg, /objective_helicopter/)
  assert.match(tankSvg, /objective_tank/)
})

test('the scene\'s air view: a square around the air tracks and the ground view, inside the air map', () => {
  const scene = {
    worldBounds: [0, 0, 1600, 1600] as [number, number, number, number],
    units: [
      { id: 0, userId: 'p', model: 'm', source: 'air' as const, path: [[0, -9000, 800], [1000, 12000, 900]] as [number, number, number][] },
      { id: 1, userId: 'q', model: 't', source: 'ground' as const, path: [[0, 800, 800]] as [number, number, number][] },
    ],
  }
  const airView = { x0: -32768, z0: -32768, x1: 32768, z1: 32768 }
  const view = sceneAirView(scene, airView)!
  assert.ok(Math.abs(view.x1 - view.x0 - 21000 * 1.06) < 1e-6, 'the longer side with a 6% margin')
  assert.ok(Math.abs(view.z1 - view.z0 - (view.x1 - view.x0)) < 1e-6, 'square')
  assert.ok(view.x0 < -9000 && view.x1 > 12000 && view.z0 < 0 && view.z1 > 1600)
  // At least 8 km; moved inside the air map; null without air tracks.
  const short = sceneAirView({ ...scene, units: [{ ...scene.units[0]!, path: [[0, 30000, 30000], [1, 30500, 30500]] }] }, airView)!
  assert.ok(short.x1 <= airView.x1 && short.z1 <= airView.z1 && short.x1 - short.x0 >= 8000)
  assert.equal(sceneAirView({ ...scene, units: [scene.units[1]!] }, airView), null)
})

test('map textures: the HQ pack\'s larger texture when installed, else the base pack\'s', () => {
  const OODLE = 0x60000000
  const dir = mkdtempSync(path.join(tmpdir(), 'wtbot-hq-'))
  try {
    const write = (rel: string, data: Buffer): void => {
      const file = path.join(dir, ...rel.split('/'))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, data)
    }
    const red = dxt1Block(0xf800)
    const blue = dxt1Block(0x001f)
    write(TACTICAL_MAP_SOURCES.maps, dxpPack([
      { name: 'lvl_map', format: 'DXT1', width: 4, height: 4, levels: 1, flags: OODLE, data: red },
      { name: 'big_map', format: 'DXT1', width: 8, height: 8, levels: 1, flags: OODLE, data: Buffer.concat([red, red, red, red]) },
    ]))
    const files = new GameFiles(dir)
    assert.equal(files.mapTexture('lvl_map')!.width, 4, 'without the HQ pack')
    write(TACTICAL_MAP_OPTIONAL_SOURCES.mapsHq, dxpPack([
      { name: 'lvl_map', format: 'DXT1', width: 8, height: 8, levels: 1, flags: OODLE | 0x00080000, data: Buffer.concat([blue, blue, blue, blue]) },
      // The game's empty HQ entries (avg_ireland_tankmap: 4096² in the base pack).
      { name: 'big_map', format: 'DXT1', width: 0, height: 0, levels: 0, flags: 0, data: Buffer.alloc(0) },
    ]))
    const hq = files.mapTexture('lvl_map')!
    assert.equal(hq.width, 8)
    assert.deepEqual([...hq.data.subarray(0, 4)], [0, 0, 255, 255])
    assert.equal(files.mapTexture('big_map')!.width, 8, 'an empty HQ entry keeps the base texture')
    assert.equal(files.mapTexture('missing_map'), null)
    assert.equal(files.hasMapTexture('lvl_map'), true)
    assert.equal(files.hasMapTexture('missing_map'), false)
    // A truncated HQ pack (a partial copy) falls back to the base pack instead of failing the map.
    write(TACTICAL_MAP_OPTIONAL_SOURCES.mapsHq, Buffer.from('DxP2 truncated'))
    assert.equal(files.mapTexture('lvl_map')!.width, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the scene\'s air view keeps working when the ground maps failed: its perspective comes from the air map\'s bases', () => {
  const events = {
    endTime: 60_000,
    units: [
      { userId: 'p1', model: 'tankModels/t', source: 'ground', path: [{ t: 0, x: 990, z: 1000 }, { t: 1000, x: 900, z: 900 }] },
      { userId: 'p2', model: 'tankModels/t', source: 'ground', path: [{ t: 0, x: 10, z: 5 }, { t: 1000, x: 100, z: 100 }] },
      { userId: 'p1', model: 'planes/f', source: 'air', path: [{ t: 0, x: 9000, z: 9000 }, { t: 1000, x: 4000, z: 3000 }] },
    ],
    kills: [],
    zones: [],
  } as unknown as ReplayEvents
  const spawns = [{ team: 'A' as const, kind: 'tank', x: 0, z: 0 }, { team: 'B' as const, kind: 'tank', x: 1000, z: 1000 }]
  const input = {
    sessionId: '1', missionName: 'm', gameMode: null, startTime: 0, durationSec: 60, teamWon: 1,
    missionArea: { x0: 0, z0: 0, x1: 1000, z1: 1000 }, mapAvailable: true, level: 'levels/avg_test.bin',
    players: [{ userId: 'p1', nick: 'a', team: 1, clanTag: null }, { userId: 'p2', nick: 'b', team: 2, clanTag: null }],
    botSlots: [],
  }
  const air = { view: { x0: -32768, z0: -32768, x1: 32768, z1: 32768 }, spawns, paddingPercent: 10 }
  // Both maps: the ground map's perspective.
  const both = buildBattleScene(events, { ...input, mapSpawns: spawns })
  assert.equal(sceneAir(both, air)?.team, 'B')
  // The ground maps failed: no map.team, and the air map's tank bases give the same side.
  const airOnly = buildBattleScene(events, { ...input, mapSpawns: null })
  assert.equal(airOnly.map.team, undefined)
  const view = sceneAir(airOnly, air)!
  assert.equal(view.team, 'B')
  assert.ok(Math.abs(view.view.x1 - view.view.x0 - 9000 * 1.1) < 1e-6, 'the margin is the air heatmaps\' padding')
  // The air map failed, or no aircraft flew: no air view.
  assert.equal(sceneAir(both, null), null)
  assert.equal(sceneAir(buildBattleScene({ ...events, units: events.units.slice(0, 2) }, { ...input, mapSpawns: spawns }), air), null)
})

test('maps carry the zone icons of every letter the atlas has', () => {
  const names = mapIconNames(MAP_SPAWN_KINDS.tank)
  assert.ok(names.includes('basezone_small_mark_a') && names.includes('basezone_small_mark_p'))
  assert.ok(names.includes('objective_tank_outline') && !names.includes('objective_fighter'))
})
