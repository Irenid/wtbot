import assert from 'node:assert/strict'
import test from 'node:test'
import { readClanAbout, type ClanTextRequirement } from './clan-about.js'

/** Requirements as short strings: "kd 1.5 ground", "age 18", "language en", "mic". */
function read(description: string): string[] {
  return (readClanAbout({ description })?.requirements ?? []).map(brief)
}

function brief(item: ClanTextRequirement): string {
  return [item.kind, item.min, item.branch, item.language].filter((part) => part !== null).join(' ')
}

test('a link written twice is one link with two places', () => {
  const slogan = 'Наш дискорд: https://discord.gg/abcDEF1'
  const description = 'Приём только через Discord: https://discord.gg/abcDEF1\nЮтуб: www.youtube.com/@team.'
  const about = readClanAbout({ slogan, description })!
  assert.deepEqual(about.links, [
    { kind: 'discord', url: 'https://discord.gg/abcDEF1', label: 'discord.gg/abcDEF1' },
    { kind: 'youtube', url: 'https://www.youtube.com/@team', label: 'youtube.com/@team' },
  ])
  const texts = { slogan, description, announcement: '' }
  assert.deepEqual(
    about.spans.map(([field, start, end, index]) => [field, texts[field].slice(start, end), index]),
    [
      ['slogan', 'https://discord.gg/abcDEF1', 0],
      ['description', 'https://discord.gg/abcDEF1', 0],
      ['description', 'www.youtube.com/@team', 1],
    ],
  )
})

test('links end at decorations and punctuation, and glued or fullwidth ones are found', () => {
  const links = (text: string): string[] => readClanAbout({ description: text })?.links.map((link) => link.url) ?? []
  assert.deepEqual(links('https://discord.gg/ju7dg╎ team'), ['https://discord.gg/ju7dg'])
  assert.deepEqual(links('Discord.https://discord.gg/x1y2'), ['https://discord.gg/x1y2'])
  assert.deepEqual(links('remember to join https;//discord.gg/typo1'), ['https://discord.gg/typo1'])
  assert.deepEqual(links('vk.com/cats. Twitch: twitch.tv/stream]'), ['https://vk.com/cats', 'https://twitch.tv/stream'])
  assert.deepEqual(links('ＤＩＳＣＯＲＤ ☎ｈｔｔｐｓ://ｄｉｓｃｏｒｄ.ｇｇ/ｐｒｔｚｎ☎'), ['https://discord.gg/prtzn'])
  const fullwidth = 'Apply via Ｄｉｓｃｏｒｄ．ｇｇ／ｖｘ９'
  const about = readClanAbout({ description: fullwidth })!
  assert.equal(about.links[0]!.url, 'https://discord.gg/vx9')
  const [, start, end] = about.spans[0]!
  assert.equal(fullwidth.slice(start, end), 'Ｄｉｓｃｏｒｄ．ｇｇ／ｖｘ９')
})

test('words with dots, e-mails, regions and versions are not links', () => {
  for (const text of ['CZ/SK cz.sk', 'Clan.Auto Accept.No Requirements.Play', 'mail clan@126.com', 'v1.2.3 and 0.9+', 'nbofss.eu']) {
    assert.equal(readClanAbout({ description: text }), null, text)
  }
})

test('links know their service, Discord first', () => {
  const about = readClanAbout({
    description: 'https://t.me/+AbC https://www.twitch.tv/name https://www.tiktok.com/@name https://dsc.gg/BT-5 https://example.org',
  })!
  assert.deepEqual(about.links.map((link) => `${link.kind} ${link.label}`), [
    'discord dsc.gg/BT-5',
    'telegram t.me/+AbC',
    'twitch twitch.tv/name',
    'tiktok tiktok.com/@name',
    'web example.org',
  ])
})

test('K/D and BR beside their keywords, with the branch they are asked in', () => {
  assert.deepEqual(read('Требования: Активность, регулярное участие в полковых боях, К/Д 0.9+, Бр 10.7+'), ['kd 0.9', 'br 10.7'])
  assert.deepEqual(
    read('Минимальные требования для вступления:\nкд ТРБ 1.0 или АРБ 0.8, БР от 10.7 (без учета премиум техники)'),
    ['kd 1 ground', 'kd 0.8 air', 'br 10.7'],
  )
  assert.deepEqual(read('Requirements: K/D 1.5+ in GRB or 1.2+ in ARB, Age 18+'), ['kd 1.5 ground', 'kd 1.2 air', 'age 18'])
  assert.deepEqual(read('ТРБ — КД 1.3+ ПРБ — КД 1.1+'), ['kd 1.3 ground', 'kd 1.1 air'])
  assert.deepEqual(read('AUFNAHMEBEDINGUNGEN\nAlter 16+ | MONATLICH 1,1 K/S AIR / 1,2 K/S GROUND'), ['kd 1.1 air', 'kd 1.2 ground', 'age 16'])
  assert.deepEqual(read('Προαπαιτούμενα: 17+ ηλικία, ▮1.1 GRB ή ▭0.9 ARB (KPS)'), ['kd 1.1 ground', 'kd 0.9 air', 'age 17'])
  assert.deepEqual(read('танкисты принимается при K\\D не менее 1.0'), ['kd 1 ground'])
  assert.deepEqual(read('Requirements 1.0 KPS in ARB and GRB'), ['kd 1'])
  assert.deepEqual(read('Wymagania: KD min. 0,5 | BR 8.7'), ['kd 0.5', 'br 8.7'])
  assert.deepEqual(read('要求主战坦克KR大于1.1，陆历月度KR大于1.3'), ['kd 1.1 ground'])
})

test('figures that are no requirement stay out', () => {
  for (const text of [
    'Средние КД Полк : Лётки | Танки - 0.52 | 0.89 - От 28.09.2026',
    'Highest squadron KD in a season ever - 2.19',
    'Не про топ-1 по КД — про вечер пятницы, взвод и угар.',
    'Premios sumando +1520 puntos en competitivo + 1000 de actividad + TOP 100',
    'Заявки на вступ без співбесіди будуть відхилятись через 24 год.',
    'Сражаемся с 2013 года, основное время 17:00-01:00 МСК',
  ]) {
    assert.deepEqual(read(text), [], text)
  }
})

test('points become PSR or activity by the words around them', () => {
  assert.deepEqual(read('Minimum 600 Activity Points'), ['activity 600'])
  assert.deepEqual(read('Requirements: 1.0 KD 1000 SQB Points per Season'), ['kd 1', 'psr 1000'])
  assert.deepEqual(read('Минимальный ЛПР на конец сезона 1300'), ['psr 1300'])
  assert.deepEqual(read('Requirements: get your 2000 activity point or 200 squadron rating'), ['psr 200', 'activity 2000'])
  assert.deepEqual(read('Обязательное участие в Полковых (как минимум 750 очков за сезон).'), ['psr 750'])
  assert.deepEqual(read('Обязательно - 720 активности в неделю.'), ['activity 720'])
  assert.deepEqual(read('月活跃度贡献须达到1500以上'), ['activity 1500'])
})

test('ages, levels, battles and vehicle ranks in their many spellings', () => {
  for (const [text, expected] of [
    ['Сервер по игре War Thunder 18+ без детей', ['age 18']],
    ['+18 Jahre', ['age 18']],
    ['age minimum 16 ans', ['age 16']],
    ['Наши требования: Возраст от [16] лет (желательно).', ['age 16']],
    ['Wiek:14+ (z wyjątkami)', ['age 14']],
    ['Mindestanforderung: Ü 18, Lvl.50, 750 Schlachten Ground-RB oder Air-RB oder Simu.', ['battles 750', 'level 50', 'age 18']],
    ['本队入队要求三点：1.能打活跃 2.等级不低于45级 3.拥有5级及以上载具', ['rank 5', 'level 45']],
    ['Requirements: Rank VII, 0.7 KPS, Discord, Know English', ['kd 0.7', 'rank 7', 'language en', 'discord']],
    ['Requirements: ages 16+, access to at least two rank 6 tech tree ground vics, or 3 rank 7 tt air vics', ['rank 6 ground', 'rank 7 air', 'age 16']],
    ['Требования: Техника 8 ранга; статистика киллы/выезд +1.2; набивать за сезон +1500 полковых очков.', ['kd 1.2', 'rank 8', 'psr 1500']],
  ] as const) {
    assert.deepEqual(read(text), expected, text)
  }
})

test('Discord, microphone and language count only as conditions', () => {
  assert.deepEqual(read('Дискорд обязателен - https://discord.gg/abc'), ['discord'])
  assert.deepEqual(read('Apply in discord: https://discord.gg/abc'), ['discord'])
  assert.deepEqual(read('If you need help, you can join Discord https://discord.gg/abc'), [])
  assert.deepEqual(read('S3AVS - AFK полк для набивания очков (Дискорд не обязателен)'), [])
  assert.deepEqual(read('Требования: БР 9.0+ и наличие микрофона'), ['br 9', 'mic'])
  assert.deepEqual(read('you have to speak english or german fluent'), ['language en', 'language de'])
  assert.deepEqual(read('Полк играет ТОЛЬКО на немецкой технике'), [])
})

test('the lines under a requirements heading are requirements', () => {
  assert.deepEqual(read('Requirements:\n• 15+ years old\n• Working microphone\n• Understandable English\n• Discord'), [
    'age 15',
    'language en',
    'mic',
    'discord',
  ])
  // A blank line ends the list.
  assert.deepEqual(read('Requirements:\n• Discord\n\nНаш Discord сервер: https://discord.gg/abc'), ['discord'])
})

test('each requirement keeps the sentence it came from', () => {
  const about = readClanAbout({ description: 'Приём через Discord.\nТребования: К/Д 0.9+, Бр 10.7+' })!
  assert.deepEqual(about.requirements.map((item) => [item.kind, item.source]), [
    ['kd', 'Требования: К/Д 0.9+, Бр 10.7+'],
    ['br', 'Требования: К/Д 0.9+, Бр 10.7+'],
    ['discord', 'Приём через Discord.'],
  ])
  assert.equal(readClanAbout({ description: 'Just a friendly squadron.' }), null)
})
