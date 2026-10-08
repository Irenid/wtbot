import assert from 'node:assert/strict'
import test from 'node:test'
import { PNG } from 'pngjs'
import type { VehicleClass } from '../wrpl/vehicles.js'
import { predictKnownTeam, type ScoutBattle } from './model.js'
import {
  allowedDistance,
  approximateFind,
  foldForMatch,
  indexPlayers,
  matchRows,
  splitTeams,
  unreadEnemyRows,
  type KnownPlayer,
} from './nick-match.js'
import { parseTesseractTsv, type OcrRow } from './ocr.js'
import { decodeImage, encodePgm, findScoreboardRows, scoreboardSheet, type RgbaImage } from './scoreboard-image.js'

/** A dark image with 8 rows of light "text" blocks (any colour), 32 px apart, and a big logo above. */
function syntheticScoreboard(color: [number, number, number]): RgbaImage {
  const width = 800
  const height = 500
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i += 1) data.set([30, 34, 40, 255], i * 4)
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) data.set([...rgb, 255], (y * width + x) * 4)
  }
  fill(300, 10, 500, 70, [200, 30, 30])
  for (let row = 0; row < 8; row += 1) {
    const y = 150 + row * 32
    // Glyph-like strokes: 3 px wide, 4 px apart, 15 px tall, on both halves.
    for (let x = 120; x < 380; x += 7) fill(x, y, x + 3, y + 15, color)
    for (let x = 420; x < 650 - row * 10; x += 7) fill(x, y, x + 3, y + 15, color)
  }
  return { width, height, data }
}

test('rows are found by contrast whatever the text colour; the sheet stacks them', () => {
  for (const color of [[230, 70, 70], [80, 170, 50], [220, 220, 220], [60, 90, 230]] as [number, number, number][]) {
    const image = syntheticScoreboard(color)
    const layout = findScoreboardRows(image)
    assert.ok(layout, `colour ${color}`)
    assert.equal(layout.rows.length, 8)
    // Bright text leaves a dark halo in the local contrast: a few px of padding.
    assert.ok(Math.abs(layout.rows[0]!.y0 - 150) <= 6)
    const sheet = scoreboardSheet(image, layout)
    assert.equal(sheet.rowSpans.length, 8)
    assert.equal(sheet.pixels.length, sheet.width * sheet.height)
    // Text is dark on a white sheet.
    assert.ok(sheet.pixels.includes(0) && sheet.pixels.includes(255))
    assert.deepEqual([...encodePgm({ width: 2, height: 1, pixels: new Uint8Array([0, 255]) })].slice(-2), [0, 255])
  }
  const blank: RgbaImage = { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4).fill(40) }
  assert.equal(findScoreboardRows(blank), null)
})

test('PNG decodes; other bytes are refused', () => {
  const png = new PNG({ width: 2, height: 1 })
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255])
  const decoded = decodeImage(new Uint8Array(PNG.sync.write(png)))
  assert.deepEqual([decoded.width, decoded.height, decoded.data[0], decoded.data[6]], [2, 1, 255, 255])
  assert.throws(() => decodeImage(new Uint8Array([1, 2, 3, 4])), /Not a PNG or JPEG/)
})

test('TSV words land in their rows with source x', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t20\t12\t40\t20\t90\t=7WOLF=',
    '5\t1\t1\t1\t1\t2\t70\t12\t60\t20\t91\tAzadx5x',
    '5\t1\t1\t1\t2\t1\t20\t60\t40\t20\t88\tGAZ9177',
    '4\t1\t1\t1\t2\t0\t20\t60\t40\t20\t-1\t',
  ].join('\n')
  const rows = parseTesseractTsv(tsv, { scale: 2, rowSpans: [{ top: 5, bottom: 40 }, { top: 50, bottom: 85 }] })
  assert.deepEqual(rows.map((row) => row.words.map((w) => w.text)), [['=7WOLF=', 'Azadx5x'], ['GAZ9177']])
  assert.equal(rows[0]!.words[1]!.x0, 35)
})

test('folding and approximate search forgive OCR look-alikes and lost underscores', () => {
  assert.equal(foldForMatch('Dr0Roger'), foldForMatch('DrORoger'))
  assert.equal(foldForMatch('ИЗ_ПИВНОЖОПИНСКА'), foldForMatch('ИЗ ПИВНОЖОПИНСКА'))
  assert.equal(foldForMatch('Beklemish1n'), foldForMatch('Beklemishin'))
  const hit = approximateFind([...'原神高手勇闯核爆原点'], [...'ches原神高手勇问核瀑原点oo'])
  assert.equal(hit.distance, 2)
  assert.equal(hit.start, 4)
  assert.equal(allowedDistance(6), 0)
  assert.equal(allowedDistance(20), 3)
})

const word = (text: string, x0: number): OcrRow['words'][number] => ({ text, x0, x1: x0 + text.length * 8, confidence: 90 })
const players: KnownPlayer[] = [
  { userId: '1', nick: 'gervewe55675', clanTag: '┾FiZZY┿' },
  { userId: '2', nick: 'Romzesi_1', clanTag: '┾FiZZY┿' },
  { userId: '10', nick: 'GivenMoment_', clanTag: '┾7WOLF┿' },
  { userId: '11', nick: 'GAZ9177@live', clanTag: '┾7WOLF┿' },
  { userId: '12', nick: 'Azadx5x', clanTag: '┾7WOLF┿' },
  // Short nicks that hide inside other text.
  { userId: '20', nick: 'Late', clanTag: '[XX]' },
  { userId: '21', nick: 'oooo', clanTag: '[YY]' },
]

test('known nicks are found in rows; the right-hand one is the enemy; short look-alikes are ignored', () => {
  const rows: OcrRow[] = [
    { words: [word('0', 10), word('0', 30), word('ZTZ96A', 100), word('FiZZY', 300), word('gervewe55675', 350), word('=7WOLF=', 520), word('GivenMoment_', 590), word('226', 900), word('0', 950)] },
    { words: [word('0', 10), word('A-10A', 100), word('Late', 150), word('Romzesi_1', 380), word('-7WOLF=', 520), word('Azadx5x', 590), word('0', 950)] },
    { words: [word('0', 10), word('Tornado', 100), word('Bekl3mish', 380), word('=7WOLF=', 520), word('GAZ9177', 590), word('0', 950)] },
    { words: [word('0', 10), word('MiG-23M', 100), word('markovka', 380), word('=7WOLF=', 520), word('DrORoger', 590), word('0', 950)] },
  ]
  const matches = matchRows(rows, indexPlayers(players))
  const split = splitTeams(matches)
  assert.deepEqual(split.enemies.map((m) => m.nick).sort(), ['Azadx5x', 'GAZ9177@live', 'GivenMoment_'])
  assert.deepEqual(split.allies.map((m) => m.nick).sort(), ['Romzesi_1', 'gervewe55675'])
  assert.ok(split.splitX! > 400 && split.splitX! < 600)
  assert.deepEqual(unreadEnemyRows(rows, split), ['=7WOLF= DrORoger'])
})

test('one team only: its side is unknown, no enemies are claimed', () => {
  const rows: OcrRow[] = [
    { words: [word('FiZZY', 300), word('gervewe55675', 350)] },
    { words: [word('FiZZY', 300), word('Romzesi_1', 350)] },
  ]
  const split = splitTeams(matchRows(rows, indexPlayers(players)))
  assert.equal(split.splitX, null)
  assert.deepEqual(split.enemies, [])
  assert.deepEqual(split.oneSide.map((m) => m.userId).sort(), ['1', '2'])
})

test('a known team gets every player at 100% and the unread rows by the class shares', () => {
  const stages = [{ startsAt: 1_791_244_800, endsAt: 1_791_849_600, maxBr: 8 }]
  const t0 = 1_791_244_800 + 15 * 3600
  const classes: Record<string, VehicleClass> = { plane: 'F', tank: 'T' }
  const battle = (id: string, start: number, vehicle: string): ScoutBattle => ({
    sessionId: id, startTime: start, endTime: start + 300, availableAt: start + 330,
    players: [{ userId: 'a', nick: 'A', vehicle, lineup: ['plane', 'tank'] }, { userId: 'b', nick: 'B', vehicle: 'tank', lineup: ['tank'] }],
  })
  const prediction = predictKnownTeam({
    players: [{ userId: 'a', nick: 'A' }, { userId: 'b', nick: 'B' }, { userId: 'c', nick: 'C' }],
    unknownPlayers: 1,
    battles: [battle('1', t0, 'plane'), battle('2', t0 + 400, 'plane')],
    now: t0 + 2000,
    stages,
    classOf: (id) => classes[id] ?? '?',
  })
  assert.equal(prediction.maxBr, 8)
  assert.equal(prediction.lastTogether?.players, 2)
  assert.deepEqual(prediction.players.map((p) => [p.nick, p.playChance, p.vehicles[0]?.vehicleId ?? null]), [['A', 1, 'plane'], ['B', 1, 'tank'], ['C', 1, null]])
  const total = Object.values(prediction.setup.expected).reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(total - 4) < 1e-9)
})
