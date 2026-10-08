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
  tagJustBefore,
  unreadEnemyRows,
  type KnownPlayer,
} from './nick-match.js'
import { parseTesseractTsv, type OcrRow } from './ocr.js'
import { decodeImage, encodePgm, findScoreboardRows, scoreboardSheet, type RgbaImage } from './scoreboard-image.js'

/**
 * A dark image with 8 rows of light "text" strokes (any colour), 32 px apart,
 * and a big logo above. `dense`: the first rows' strokes packed like CJK;
 * `frame`: the own row's frame line under row 0; `header`: a line of text
 * 1.15 pitches above the table (column icons).
 */
function syntheticScoreboard(color: [number, number, number], options: { dense?: number; frame?: boolean; header?: boolean } = {}): RgbaImage {
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
    // Glyph-like strokes: 3 px wide, 4 px apart (dense: 2 and 2), 15 px tall, on both halves.
    const [stroke, step] = row < (options.dense ?? 0) ? [2, 4] : [3, 7]
    for (let x = 120; x < 380; x += step) fill(x, y, x + stroke, y + 15, color)
    for (let x = 420; x < 650 - row * 10; x += step) fill(x, y, x + stroke, y + 15, color)
  }
  if (options.frame) fill(0, 170, 400, 172, [220, 220, 220])
  if (options.header) for (let x = 120; x < 650; x += 7) fill(x, 114, x + 3, 127, color)
  return { width, height, data }
}

test('rows are found by contrast whatever the text colour; the sheet stacks them', () => {
  for (const color of [[230, 70, 70], [80, 170, 50], [220, 220, 220], [60, 90, 230]] as [number, number, number][]) {
    const image = syntheticScoreboard(color)
    const layout = findScoreboardRows(image)
    assert.ok(layout, `colour ${color}`)
    assert.equal(layout.rows.length, 8)
    assert.equal(layout.rows[0]!.y0, 150)
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

test('dense rows, the own row frame and a header line above stay out of each other', () => {
  const layout = findScoreboardRows(syntheticScoreboard([230, 70, 70], { dense: 3, frame: true, header: true }))
  assert.deepEqual(layout?.rows.map((row) => [row.y0, row.y1]), [150, 182, 214, 246, 278, 310, 342, 374].map((y) => [y, y + 15]))
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

test('folding and approximate search forgive OCR look-alikes, accents and lost underscores', () => {
  assert.equal(foldForMatch('Dr0Roger'), foldForMatch('DrORoger'))
  assert.equal(foldForMatch('ИЗ_ПИВНОЖОПИНСКА'), foldForMatch('ИЗ ПИВНОЖОПИНСКА'))
  assert.equal(foldForMatch('Beklemish1n'), foldForMatch('Beklemishin'))
  assert.equal(foldForMatch('Loupák'), foldForMatch('Loupak'))
  assert.equal(foldForMatch('Łukasz'), foldForMatch('lukasz'))
  assert.equal(foldForMatch('ТрусикиСталина#1').length, foldForMatch('ТрусикиСталина1').length)
  assert.equal([...foldForMatch('한국')].length, 2)
  const hit = approximateFind([...'原神高手勇闯核爆原点'], [...'ches原神高手勇问核瀑原点oo'])
  assert.equal(hit.distance, 2)
  assert.equal(hit.start, 4)
  assert.equal(allowedDistance(6), 0)
  assert.equal(allowedDistance(20), 3)
  // A tag right before the nick (up to a few frame characters between), never one further back.
  assert.equal(tagJustBefore([...'izgoy'], [...'anasizgoym']), true)
  assert.equal(tagJustBefore([...'nashi'], [...'anasizgoym']), false)
  assert.equal(tagJustBefore([...'wiiiy'], [...'mawiiiyhed']), true)
})

const word = (text: string, x0: number): OcrRow['words'][number] => ({ text, x0, x1: x0 + text.length * 8, confidence: 90 })
/** Own nicks are right-aligned before the rank badge. */
const own = (text: string, x1 = 300): OcrRow['words'][number] => ({ text, x0: x1 - text.length * 8, x1, confidence: 90 })
const players: KnownPlayer[] = [
  { userId: '1', nick: 'gervewe55675', clanTag: '┾FiZZY┿' },
  { userId: '2', nick: 'Romzesi_1', clanTag: '┾FiZZY┿' },
  { userId: '10', nick: 'GivenMoment_', clanTag: '┾7WOLF┿' },
  { userId: '11', nick: 'GAZ9177@live', clanTag: '┾7WOLF┿' },
  { userId: '12', nick: 'Azadx5x', clanTag: '┾7WOLF┿' },
  // Short nicks that hide inside other text.
  { userId: '20', nick: 'Late', clanTag: '[XX]' },
  { userId: '21', nick: 'oooo', clanTag: '[YY]' },
  // Under 3 distinct characters: score zeros read as Cyrillic о matched it.
  { userId: '22', nick: 'ooooooox', clanTag: '┾FiZZY┿' },
]

test('known nicks are found in rows; the right-hand one is the enemy; short look-alikes are ignored', () => {
  const rows: OcrRow[] = [
    { words: [word('0', 10), word('0', 30), word('ZTZ96A', 100), word('FiZZY', 300), word('gervewe55675', 350), word('=7WOLF=', 520), word('GivenMoment_', 590), word('226', 900), word('0', 950)] },
    { words: [word('0', 10), word('A-10A', 100), word('Late', 150), word('Romzesi_1', 380), word('-7WOLF=', 520), word('Azadx5x', 590), word('0', 950)] },
    { words: [word('0', 10), word('Tornado', 100), word('Bekl3mish', 380), word('=7WOLF=', 520), word('GAZ9177', 590), word('0', 950)] },
    { words: [word('оооооо', 10), word('MiG-23M', 100), word('markovka', 380), word('=7WOLF=', 520), word('DrORoger', 590), word('о', 950)] },
  ]
  const indexed = indexPlayers(players)
  assert.equal(indexed.some((player) => player.userId === '22'), false)
  const matches = matchRows([rows], indexed)
  const split = splitTeams(matches)
  assert.deepEqual(split.enemies.map((m) => m.nick).sort(), ['Azadx5x', 'GAZ9177@live', 'GivenMoment_'])
  assert.deepEqual(split.allies.map((m) => m.nick).sort(), ['Romzesi_1', 'gervewe55675'])
  assert.ok(split.splitX! > 400 && split.splitX! < 600)
  assert.deepEqual(unreadEnemyRows([rows], split), [{ row: 3, text: 'DrORoger' }])
})

test('every pass is searched: a nick read in one counts, the best find wins', () => {
  // The Cyrillic pass reads a Latin nick in Cyrillic look-alikes; the Latin pass reads it right.
  const cyrillic: OcrRow[] = [{ words: [word('FiZZY', 300), word('gervewe55675', 350), word('-7WOLF=', 520), word('Агадх5х', 590)] }]
  const latin: OcrRow[] = [{ words: [word('FiZZY', 300), word('gervewe55675', 350), word('-7WOLF=', 520), word('Azadx5x', 590)] }]
  const indexed = indexPlayers(players)
  assert.deepEqual(splitTeams(matchRows([cyrillic], indexed)).enemies, [])
  const split = splitTeams(matchRows([cyrillic, latin], indexed))
  assert.deepEqual(split.enemies.map((m) => [m.nick, m.distance, m.tagSeen]), [['Azadx5x', 0, true]])
})

test('one team only: its side is unknown, no enemies are claimed', () => {
  const rows: OcrRow[] = [
    { words: [word('FiZZY', 300), word('gervewe55675', 350)] },
    { words: [word('FiZZY', 300), word('Romzesi_1', 350)] },
  ]
  const split = splitTeams(matchRows([rows], indexPlayers(players)))
  assert.equal(split.splitX, null)
  assert.deepEqual(split.enemies, [])
  assert.deepEqual(split.oneSide.map((m) => m.userId).sort(), ['1', '2'])
})

test('a moved player goes with the tag shown before him; a squadron mate off the column is no ally', () => {
  // No row holds two strong finds: the split comes from the two squadrons, dennis7781 in his new one.
  const indexed = indexPlayers([
    { userId: '1', nick: 'Kirillich_08#1', clanTag: '╀PD15╀' },
    { userId: '2', nick: 'SEVI_ADOJIF', clanTag: '╀PD15╀' },
    { userId: '3', nick: 'ArthurPendragon#1', clanTag: '=FTNDS=' },
    { userId: '4', nick: 'dennis7781', clanTag: '╔CH68╕' },
    { userId: '5', nick: '_Guenter_', clanTag: '┺EREZ┻' },
    { userId: '6', nick: 'Akagi', clanTag: '╀PD15╀' },
  ])
  const rows: OcrRow[] = [
    { words: [own('$Р015®', 228), own('_Guenter_'), word('=FTNDS=', 340), word('天', 400), word('生', 416), word('我', 432), word('о', 600)] },
    { words: [own('OPD15', 188), own('Kirillich_08#1'), word('=FTNDS=', 340), word('MHS', 400)] },
    { words: [word('Akagi', 10), own('OPD15O', 204), own('SEVI_ADOJIF'), word('=FTNDS=', 340), word('kexik1234', 400)] },
    { words: [own('PD15', 220), own('ПИВОГЛОТ282'), word('=FTNDS=', 340), word('ArthurPendragon#1', 400)] },
    { words: [own('Berthold...', 236), own('dvandam'), word(':FTNDS=', 340), word('dennis7781', 400)] },
  ]
  const split = splitTeams(matchRows([rows], indexed))
  assert.deepEqual(split.enemies.map((m) => [m.userId, m.squadron]), [['3', 'ftnds'], ['4', 'ftnds']])
  assert.deepEqual(split.allies.map((m) => m.userId), ['5', '1', '2'])
  assert.deepEqual(unreadEnemyRows([rows], split).map((unread) => unread.text), ['天生我', 'MHS', 'kexik1234'])
})

test('a tag counts right before the nick only; nicks folding alike are told apart by the tag, then the spelling', () => {
  const indexed = indexPlayers([
    { userId: '1', nick: '__Maverick____', clanTag: '═NASHI║' },
    { userId: '2', nick: '__MAVERiCK__', clanTag: '┼IZGOY┽' },
    { userId: '3', nick: 'DYADYA_VLAD', clanTag: '┼IZGOY┽' },
    { userId: '4', nick: 'DYADYA_VLAD_', clanTag: '┼IZGOY┽' },
  ])
  const rows: OcrRow[] = [
    // The plane icon read as "ANA" before the tag holds "nasi", one edit from NASHI.
    { words: [word('Scimitar', 10), word('FMk1', 90), word('ANA', 140), own('SIZGOY=', 236), own('__MAVERICK_')] },
    { words: [own('SIZGOYA', 196), own('DYADYA_VLAD_')] },
  ]
  const matches = matchRows([rows], indexed)
  assert.deepEqual(matches.map((row) => row.map((m) => [m.userId, m.tagSeen])), [[['2', true]], [['4', true]]])
})

test('a decorated nick is found by its letters; a long nick with an edit beats a short exact one inside it', () => {
  const indexed = indexPlayers([
    { userId: '1', nick: 'GRIMッ', clanTag: '┾7WOLF┿' },
    { userId: '2', nick: 'ЯсельныйГенералヅ', clanTag: '┾7WOLF┿' },
    { userId: '3', nick: 'メAce', clanTag: '┾7WOLF┿' },
    { userId: '4', nick: '青春爆二不会遇到T90学姐', clanTag: '┾7WOLF┿' },
  ])
  // Decorations only: the letters of a mostly Chinese nick are no pattern of their own.
  assert.equal(indexed.find((player) => player.userId === '4')!.plain, null)
  const latin: OcrRow[] = [{ words: [word('=7WOLF=', 500), word('GRIM', 560)] }, { words: [word('=7WOLF=', 500), word('AcenbHbiiiTenepan', 560)] }]
  const cyrillic: OcrRow[] = [{ words: [word('=7WOLF=', 500), word('СКІМ', 560)] }, { words: [word('=7WOLF=', 500), word('ЯсельныйГенерал‘У', 560)] }]
  const matches = matchRows([latin, cyrillic], indexed)
  assert.deepEqual(matches.map((row) => row.map((m) => m.userId)), [['1'], ['2']])
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

test('Greek and stroked letters fold to their Latin look-alikes, as OCR reads them', () => {
  assert.equal(foldForMatch('MΛRS'), 'mars')
  assert.equal(foldForMatch('ZΞROX'), 'zerox')
  assert.equal(foldForMatch('Λthena_0ł'), 'athenaoi')
})

test('a known team with flags read: a player between two nations takes the flagged one', () => {
  const stages = [{ startsAt: 1_791_244_800, endsAt: 1_791_849_600, maxBr: 8 }]
  const t0 = 1_791_244_800 + 15 * 3600
  const battle = (id: string, start: number, vehicle: string): ScoutBattle => ({
    sessionId: id, startTime: start, endTime: start + 300, availableAt: start + 330,
    players: [{ userId: 'a', nick: 'A', vehicle, lineup: ['us_tank', 'de_tank'] }],
  })
  const input = {
    players: [{ userId: 'a', nick: 'A' }],
    unknownPlayers: 0,
    battles: [battle('1', t0, 'de_tank'), battle('2', t0 + 400, 'us_tank'), battle('3', t0 + 800, 'us_tank')],
    now: t0 + 1500,
    stages,
    classOf: (): VehicleClass => 'T',
  }
  const plain = predictKnownTeam(input)
  assert.equal(plain.players[0]!.vehicles[0]!.vehicleId, 'us_tank')
  assert.equal(plain.flags, null)
  const flagsOf = (id: string) => ({ us_tank: 'usa', de_tank: 'germany' } as Record<string, string>)[id]
  const flagged = predictKnownTeam({
    ...input,
    flags: {
      flags: [[{ icon: 'germany', likelihood: 1 }]],
      seats: [{ place: 0, inVehicle: null }],
      flagsOf: (id: string) => { const icon = flagsOf(id); return icon ? { operator: icon, tree: [{ icon, share: 1 }] } : null },
    },
  })
  assert.equal(flagged.players[0]!.vehicles[0]!.vehicleId, 'de_tank')
  assert.deepEqual(flagged.flags?.icons, ['germany'])
})
