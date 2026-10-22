import { pluralizer } from './plural.js'
import { regionName } from './regions.js'
import type { BotText } from './types.js'

/**
 * Russian, in the game's Russian terms: полк (squadron), БР, ЛПР, АБ/РБ/СБ.
 * Player-facing text is plain and short (no jargon or abbreviations).
 */
const plural = pluralizer('ru-RU')
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const regions = new Intl.DisplayNames('ru-RU', { type: 'region' })

const count = (value: number, one: string, few: string, many: string): string =>
  `${value} ${plural(value, { one, few, many, other: few })}`
const atBr = (br: string | null): string => (br === null ? '' : ` на БР ${br}`)
const chancesOwn = (br: string | null): string => `Шансы техники — по собственным боям каждого игрока${atBr(br)}.`

const FLAGS: Record<string, string> = {
  usa: 'США',
  ussr: 'СССР',
  britain: 'Великобритания',
  gdr: 'ГДР',
  republic_china: 'Китайская Республика',
  south_vietnam: 'Южный Вьетнам',
  uae: 'ОАЭ',
  north_korea: 'КНДР',
}

export const ru: BotText = {
  intl: 'ru-RU',
  number: (value) => numberFormat.format(value),
  languageName: 'Русский',

  commands: {
    battle: {
      description: 'Результаты боя из реплея War Thunder (картинкой)',
      id: 'sessionId боя (по умолчанию — последний бой)',
    },
    language: {
      description: 'Выбрать язык бота на этом сервере',
      language: 'Язык постов и команд бота на этом сервере',
    },
    ping: { description: 'Проверка, что бот жив' },
    stats: { description: 'Статистика бота и сбора данных' },
    playerBoard: {
      description: 'Табло статистики игроков в голосовых каналах',
      setup: 'Создать табло или перенести его в другой канал',
      channel: 'Канал для постоянно обновляемого табло',
      status: 'Показать, где находится табло',
      refresh: 'Перерисовать табло из сохранённых данных',
      disable: 'Отключить обновление табло',
    },
    scout: {
      description: 'Предсказать игроков и технику полка противника по его недавним боям',
      squadron: 'Тег или название полка, как в игре',
      player: 'Ник из команды противника: выбирает нужную группу, если играют две',
    },
    settings: {
      description: 'Выбрать, куда бот пишет и что отслеживает на этом сервере',
      show: 'Показать каналы и язык бота и кому доступны его команды',
      battles: 'Каналы для постов о боях',
      battlesAdd: 'Постить бои в канал: одного полка или всех полков',
      battlesRemove: 'Перестать постить бои в канал',
      scout: 'Каналы, где бот читает скриншоты таблицы',
      scoutAdd: 'Читать скриншоты таблицы (Tab) в канале',
      scoutRemove: 'Перестать читать скриншоты в канале',
      voice: 'Голосовые каналы на табло игроков',
      voiceAdd: 'Показывать на табло игроков голосового канала или всех голосовых каналов категории',
      voiceRemove: 'Убрать с табло голосовой канал или категорию',
      stats: 'Каналы с местом и числом игроков полка',
      statsSet: 'Создать два канала с местом и числом игроков полка',
      statsCategory: 'Категория для каналов; пусто — вверху списка (нужно больше прав)',
      statsRemove: 'Удалить каналы с местом и числом игроков',
      platoons: 'Взводы: бот подсказывает, кому из игроков в голосовых лучше играть',
      platoonsSet: 'Подсказывать взводы по игрокам в голосовом канале и комнатах рядом с ним',
      platoonsRemove: 'Больше не подсказывать взводы',
      lobby: 'Голосовой канал, где собираются игроки; комнаты — голосовые каналы его категории',
      platoonsChannel: 'Куда писать подсказки; пусто — в чат этого голосового канала',
      channel: 'Канал',
      squadron: 'Тег или название полка; пусто — бои всех полков',
      squadronRemove: 'Только посты этого полка; пусто — все посты канала',
    },
  },

  language: {
    guildOnly: 'Эта команда доступна только на Discord-сервере.',
    changed:
      'Теперь бот пишет на этом сервере по-русски: посты о боях, табло игроков, а через минуту и описания команд. ' +
      'Ответы, которые видите только вы, приходят на языке вашего Discord.',
  },

  settings: {
    guildOnly: 'Эта команда доступна только на Discord-сервере.',
    badChannel: 'Выберите канал этого сервера.',
    cannotView: (channel) => `Вы сами не видите ${channel}, поэтому не можете настроить там бота.`,
    permissions: {
      view: 'Просматривать канал',
      send: 'Отправлять сообщения',
      attach: 'Прикреплять файлы',
      embed: 'Встраивать ссылки',
      history: 'Читать историю сообщений',
      manage: 'Управлять каналами',
      connect: 'Подключаться',
    },
    missingPermissions: (channel, permissions) =>
      `Боту не хватает прав в ${channel}: ${permissions}. Выдайте их его роли в этом канале и повторите команду.`,
    squadronNotFound: (query) => `Бот не знает полк «${query}». Напишите тег так, как его показывает игра.`,
    limit: (max) => `На этом сервере уже ${max} таких каналов. Сначала уберите один.`,
    battlesAdded: (channel, squadron) => squadron === null
      ? `В ${channel} будут приходить все полковые бои, которые находит бот: больше тысячи постов в день.`
      : `В ${channel} будут приходить бои полка ${squadron}.`,
    battlesExists: (channel, squadron) => squadron === null
      ? `В ${channel} уже приходят все полковые бои.`
      : `В ${channel} уже приходят бои полка ${squadron}.`,
    battlesRemoved: (channel) => `В ${channel} больше не будет постов о боях.`,
    scoutAdded: (channel, mentionOnly) =>
      `На скриншот таблицы (Tab) в ${channel} бот ответит вероятным составом и техникой противника.` +
      (mentionOnly ? ' Упомяните бота в сообщении: иначе он не видит картинку.' : ''),
    scoutExists: (channel) => `Скриншоты в ${channel} уже читаются.`,
    scoutRemoved: (channel) => `Скриншоты в ${channel} больше не читаются.`,
    voiceAdded: (channel, hiddenOnBoard, category) =>
      (category
        ? `Табло показывает игроков всех голосовых каналов ${channel}, в том числе комнат, которые там создадут потом, ` +
          'и только других выбранных каналов.'
        : `Табло показывает игроков ${channel} и только других выбранных голосовых каналов.`) +
      (hiddenOnBoard ? ' Часть тех, кто видит табло, не видит этот канал, поэтому табло его не показывает.' : ''),
    voiceExists: (channel) => `Табло уже показывает ${channel}.`,
    voiceRemoved: (channel, othersLeft) => othersLeft
      ? `Табло больше не показывает ${channel}.`
      : `Табло больше не показывает ${channel} и снова показывает все голосовые каналы, которые видит бот, ` +
        'кроме скрытых от части тех, кто видит табло.',
    notSet: (channel) => `Для ${channel} это не было настроено.`,
    statsNeedsPermissions: (permissions) =>
      `Чтобы создать каналы вверху списка, боту нужны права на сервере: ${permissions} — он создаёт каналы, ` +
      'открытые всем, и переименовывает их. Или выберите категорию, где у его роли есть права «Просматривать канал» ' +
      'и «Управлять каналами».',
    statsSet: (squadron, category) =>
      (category === null
        ? `Вверху списка каналов появились два голосовых канала с местом и числом игроков полка ${squadron} ` +
          '(текстовые каналы вне категорий Discord показывает выше них): их видят все, но зайти в них и что-то в них делать нельзя.'
        : `В ${category} появились два голосовых канала с местом и числом игроков полка ${squadron} с правами категории: ` +
          'их видят все, кто видит категорию.') +
      ' Они меняются в течение минуты после нового чтения таблицы лидеров, не чаще раза в 20 минут. ' +
      'Двигать и переименовывать их можно; удалите один — удалятся оба.',
    statsRemoved: 'Каналы с местом и числом игроков удалены.',
    statsNotSet: 'На этом сервере нет каналов с местом и числом игроков.',
    platoonsSet: (lobby, squadron, channel) => `Подсказки по взводам включены: бот следит за игроками ${squadron} в ${lobby} и голосовых каналах `
      + `рядом с ним и, пока там есть игроки, пишет в ${channel}, кому где лучше играть. Никого не перемещает.`,
    platoonsRemoved: 'Подсказки по взводам выключены, их сообщение удалено.',
    platoonsNotSet: 'Подсказки по взводам на этом сервере не настроены.',
    statsPlaceName: (place) => `Место полка: ${place ?? '–'}`,
    statsMembersName: (members) => `Игроков в полку: ${members ?? '–'}`,
    statsRatingName: (rating) => `Средний рейтинг полка: ${rating ?? '–'}`,
    show: {
      title: 'Бот на этом сервере',
      language: 'Язык',
      battles: 'Посты о боях',
      scout: 'Скриншоты читаются в',
      voice: 'Голосовые каналы на табло',
      playerBoard: 'Табло игроков',
      stats: 'Каналы с местом и числом игроков',
      noStats: 'нет: /settings stats set',
      platoons: 'Взводы',
      noPlatoons: 'выключены: /settings platoons set',
      platoonsValue: (lobby, squadron, channel) => `${squadron} в ${lobby}, подсказки в ${channel}`,
      access: 'Кто может пользоваться командами',
      languageValue: (name, chosen) => chosen ? name : `${name} (по умолчанию; меняется командой /language)`,
      everySquadron: 'все полки',
      noBattles: 'нет: /settings battles add',
      noScout: 'нет: /settings scout add',
      allVoice: 'все голосовые каналы, которые видит бот, кроме скрытых от части тех, кто видит табло',
      noBoard: 'нет: /playerboard setup',
      missing: (permissions) => `⚠ боту не хватает прав: ${permissions}`,
      hiddenOnBoard: '⚠ его видят не все, кто видит табло: на табло не показывается',
      wholeCategory: '— все голосовые каналы категории',
      footer:
        'Кнопки под постами о боях отвечают всем, кто видит пост. Бот читает скриншоты всех, кто может писать ' +
        'в канал. Табло не показывает голосовой канал, который видят не все, кто видит табло.',
    },
    access: {
      everyone: 'все',
      manageGuild: 'участники с правом «Управлять сервером»',
      adminsOnly: 'только администраторы',
      needsPermissions: 'участники с нужными правами',
      also: (list) => `также ${list}`,
      only: (list) => `только ${list}`,
      except: (list) => `кроме ${list}`,
      onlyIn: (channels) => `только в ${channels}`,
      alsoIn: (channels) => `также в ${channels}`,
      notIn: (channels) => `не в ${channels}`,
      noChannel: 'ни в одном канале',
      everyCommand: 'Все команды',
      note: (bot) => `Администраторам доступны все команды. Изменить, кому доступна команда: Настройки сервера → Интеграции → ${bot}.`,
      unread: 'Discord не сообщил, кому доступны команды. Попробуйте позже.',
    },
  },

  failure: {
    command: 'Произошла ошибка при выполнении команды.',
    battleMedia: 'Произошла ошибка при сборке материалов боя.',
  },

  ping: (milliseconds) => `🏓 Понг! WebSocket: ${milliseconds === null ? 'н/д' : `${milliseconds} мс`}`,

  stats: {
    title: '📊 Статистика',
    fields: {
      uptime: 'Работает',
      servers: 'Серверы',
      commandsRun: 'Выполнено команд',
      itemsCollected: 'Собрано записей',
      season: 'Сезон полковых боёв',
      topCommands: 'Частые команды',
      parsers: 'Парсеры',
    },
    noCommands: 'пока нет',
    noParsers: 'ещё не запускались',
    uptime: (days, hours, minutes, seconds) =>
      [days > 0 ? `${days} д` : '', hours > 0 ? `${hours} ч` : '', minutes > 0 ? `${minutes} мин` : '', `${seconds} с`]
        .filter((part) => part !== '')
        .join(' '),
    season: {
      noSchedule: 'нет расписания',
      ended: (time) => `сезон закончился ${time}`,
      betweenStages: 'между этапами',
      untilEnd: 'до конца сезона',
      week: (week) => `неделя ${week}`,
      maxBr: (br) => `макс. БР ${br}`,
      nextMaxBr: (br, time) => `макс. БР ${br} ${time}`,
      ends: (time) => `сезон закончится ${time}`,
    },
  },

  battle: {
    notFound: (id) => `Реплей \`${id}\` не найден в базе.`,
    noReplays: 'В базе пока нет реплеев — парсер ещё не принёс данные.',
    noParts: 'У этой записи нет ссылок на файлы реплея.',
    matchId: 'ID боя',
    team: (number) => `Команда ${number}`,
    maxBr: (br) => `Макс. БР ${br}`,
    place: (place) => `#${place}`,
    dayRecord: (wins, losses) => `${wins}В ${losses}П`,
    buttons: {
      replay: 'Реплей',
      chat: 'Чат',
      log: 'Лог боя',
      heatmapGround: 'Карта (земля)',
      heatmapAir: 'Карта (воздух)',
      teamGround: (squadron) => `${squadron} (земля)`,
      teamAir: (squadron) => `${squadron} (воздух)`,
      scaleUp: 'Открыть в 2×',
      scaleDown: 'Вернуть 1×',
    },
    media: {
      log: 'лог боя',
      'heatmap-ground': 'карту наземной техники',
      'heatmap-air': 'карту авиации',
      'heatmap-team-0': 'карту первого полка',
      'heatmap-team-1': 'карту второго полка',
      'heatmap-team-air-0': 'воздушную карту первого полка',
      'heatmap-team-air-1': 'воздушную карту второго полка',
      chat: 'чат',
    },
    noReplayForHd: 'Реплей этого боя не найден в базе — собрать карту в 2× не из чего.',
    noReplayForMedia: 'Реплей этого боя не найден в базе — собрать материалы не из чего.',
    buildFailed: (media, scale) =>
      `Не получилось собрать ${media} в ${scale}×.\nФайлы реплея могли уже удалиться с CDN (они хранятся около двух недель).`,
    buildBusy: (media, scale) => `Бот занят и не смог собрать ${media} в ${scale}×. Попробуйте через минуту.`,
    hdOverLimitNoCache: 'Версия 2× превышает лимит вложения Discord, а версии 1× нет в кэше. Откройте карту заново.',
    hdOverLimit: (mebibytes) => `Версия 2× весит ${mebibytes} МиБ и превышает лимит Discord; показана версия 1×.`,
    chatTitle: 'Чат боя',
    unparsed: 'Реплей не удалось разобрать.',
  },

  image: {
    duration: (time) => `бой ${time}`,
    bot: 'Бот',
  },

  scoreboard: {
    victory: 'Победа',
    unknownPlayer: 'Неизвестный игрок',
    disconnected: 'Отключился',
    botDriven: 'бот',
  },

  battleLog: {
    title: 'Лог боя',
    versus: 'против',
    empty: 'Событий не найдено',
    more: (more) => `… ещё ${count(more, 'событие', 'события', 'событий')}`,
    verbs: {
      kill: ['уничтожил', 'разбился'],
      fire: ['поджёг', 'загорелся'],
      severe: ['тяжело повредил', 'тяжело повреждён'],
    },
    legend: { kill: 'уничтожение', fire: 'поджог', severe: 'тяжёлое повреждение' },
    distance: (metres) => `${metres} м`,
  },

  heatmap: {
    battle: 'Бой',
    ground: 'наземная техника',
    air: 'авиация',
    routes: (squadron) => `маршруты: ${squadron}`,
    date: (start) => `${dateFormat.format(start)}, ${timeFormat.format(start)}`,
    duration: (time) => `Длительность: ${time}`,
    teamSummary: (players, kills, survivors) =>
      `${count(players, 'игрок', 'игрока', 'игроков')} · ${count(kills, 'фраг', 'фрага', 'фрагов')} · ` +
      `${survivors} ${plural(survivors, { one: 'выжил', other: 'выжили' })}`,
    victory: 'победа',
    died: (time) => `погиб ${time}`,
    alive: 'жив',
    points: (score) => `${score} очк.`,
    noPaths: 'без траекторий в этом режиме',
    legendTitle: 'Обозначения',
    legend: {
      path: 'траектория',
      minute: 'минута боя',
      stop: 'стоянка и её время',
      shot: 'выстрел убийцы',
      death: 'гибель (цвет — чей)',
      cause: 'чем убит',
      causeNotTank: 'убийца, если не танк',
      survivor: 'жив в конце боя',
      uav: 'БПЛА и зона обзора',
    },
    spawn: {
      centre: 'спавн в центре',
      right: 'спавн справа',
      topRight: 'спавн сверху справа',
      top: 'спавн сверху',
      topLeft: 'спавн сверху слева',
      left: 'спавн слева',
      bottomLeft: 'спавн снизу слева',
      bottom: 'спавн снизу',
      bottomRight: 'спавн снизу справа',
    },
    causes: { ir: 'ИК', sarh: 'ПАРЛ', arh: 'АРЛ', sam: 'ЗУР' },
  },

  chat: {
    empty: 'В этом бою никто не писал в чат.',
    channels: ['КОМАНДА', 'ВСЕ', 'ОТРЯД', 'ЛС'],
    unknownChannel: (channel) => `НЕИЗВЕСТНО(${channel})`,
  },

  scout: {
    classCount: (cls, value) => {
      switch (cls) {
        case 'F': return count(value, 'самолёт', 'самолёта', 'самолётов')
        case 'H': return count(value, 'вертолёт', 'вертолёта', 'вертолётов')
        case 'T': return count(value, 'танк', 'танка', 'танков')
        case 'L': return count(value, 'лёгкий танк', 'лёгких танка', 'лёгких танков')
        case 'AA': return `${value} ЗСУ`
      }
    },
    nobody: 'никого',
    groups: {
      F: 'Самолёты',
      H: 'Вертолёты',
      T: 'Танки',
      L: 'Лёгкие танки',
      AA: 'ЗСУ',
      unknown: 'Техника неизвестна',
    },
    flag: (base) =>
      FLAGS[base] ?? regionName(regions, base) ??
      base.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
    plays: (chance) => `играет ${chance}`,
    noBattlesAtBr: 'ещё нет боёв на этом БР',
    likely: (vehicles) => `ещё нет боёв на этом БР, вероятно ${vehicles}`,
    newMark: 'новая',
    newVehicle: (chance) => `новая техника ${chance}`,
    otherNewVehicle: (chance) => `другая новая техника ${chance}`,
    nothingStored: 'За последние две недели боёв полка не сохранено — предсказывать не из чего.',
    lastBattleSession: (time) => `Последний бой ${time}, полк ещё играет: скорее всего, выйдут те же игроки.`,
    lastBattleGuess: (time, minutes) =>
      `Последний бой ${time}, за последние ${minutes} минут боёв не было: состав — догадка по тем, кто недавно играл в это время суток.`,
    hintMatched: (nick) => `Показана группа **${nick}**.`,
    hintMissed: (nick) => `**${nick}** нет в недавних боях полка, поэтому показана его последняя группа.`,
    basedOn: (battles, br) => `По ${battles} ${plural(battles, { one: 'бою', other: 'боям' })} полка${atBr(br)}.`,
    otherGroupTitle: 'В это же время играет другая группа',
    otherGroup: (time, nicks) =>
      `Последний бой ${time}: ${nicks}.\nЕсли попали на них, повторите /scout с одним из этих ников в \`player\`.`,
    setupTitle: 'Самый вероятный состав',
    air: (expected, chance) => `**Авиация:** ожидается ${expected}, хотя бы одна машина ${chance}`,
    enemyTeam: 'Команда противника',
    readFromScreenshot: (read, total) => `Прочитано со скриншота: ${read} из ${total} игроков противника.`,
    lastTogether: (time) => `Последний раз играли вместе ${time}.`,
    chancesWithFlags: (br, countries) =>
      `Шансы техники — по собственным боям каждого игрока${atBr(br)} и флагам над командой противника: ${countries}.`,
    withoutFlag: (value) =>
      `Без флага (ещё не выехали или уничтожены): ${count(value, 'противник', 'противника', 'противников')} — их шансы только по их боям.`,
    chancesOwn,
    noneSpawned: (br) =>
      `${chancesOwn(br)} Никто из противников ещё не выехал: скриншот после выезда покажет их флаги и уточнит прогноз.`,
    flagsUnread: (br) =>
      `${chancesOwn(br)} Флаги над командой противника не прочитаны: скриншот, где они видны, уточнит прогноз.`,
    spawnFirst: (br) => `${chancesOwn(br)} Скриншот после выезда покажет их флаги и уточнит прогноз.`,
    killsNarrow: (value) =>
      value === 1
        ? 'То, что уже уничтожил или захватил 1 противник, тоже сужает выбор его техники.'
        : `То, что уже уничтожили или захватили ${count(value, 'противник', 'противника', 'противников')}, тоже сужает выбор их техники.`,
    newGuessed: (players) =>
      `Техника, которую игрок ещё не брал на этом БР (новая), угадывается по тому, что на нём берут полки${
        players > 0 ? ` и по его боям на StatShark (${count(players, 'игрок', 'игрока', 'игроков')})` : ''
      }.`,
    statSharkPending: 'Проверяю их бои на StatShark: ответ обновится через минуту-две.',
    notRecognised: (value) => `Не распознано · ${value}`,
    anonymousGuess: (nick, fakeName) => `${nick} (вероятно: скрыт как ${fakeName})`,
    choicePlace: (place) => `место ${place}`,
    choiceNoBattles: 'боёв не сохранено',
    squadronNotFound: (query) => `Полк «${query}» не найден. Введите тег так, как его показывает игра, например WLILY.`,
    images: {
      tooMany: 'Слишком много скриншотов сразу, попробуйте через минуту.',
      tooLarge: 'Картинка больше 25 МБ.',
      noOcr: 'Чтение скриншотов на этом боте недоступно (не установлен OCR).',
      unreadable: 'Не получилось прочитать этот скриншот.',
      noTable: 'Таблица не найдена. Пришлите скриншот таблицы Tab с обеими командами.',
      noPlayers: 'На таблице не найдено известных игроков. Поможет более чёткий скриншот без обрезки — или /scout с тегом противника.',
      oneSide: (squadron) =>
        `Прочитана только одна команда (${squadron ?? 'один полк'}). Противники — в правой половине таблицы: пришлите скриншот с обеими командами.`,
    },
  },

  platoons: {
    title: (cap) => `Рекомендованные сетапы${cap === null ? '' : ` · БР ${cap.toFixed(1)}`}`,
    room: (name, players) => `${name} · ${players}/8`,
    short: (missing) => ` · не хватает ${missing}`,
    newPlatoon: (index) => `Новый взвод${index === null ? '' : ` ${index}`} · 8/8, нужна комната`,
    forming: (count) => `Следующий взвод · ${count}/8`,
    empty: 'В голосовых каналах пока никого нет.',
    notPlaced: 'Не распределены',
    swap: (inNick, outNick) => `${inNick} вместо ${outNick}`,
    tags: {
      deaf: 'выключен звук',
      guest: 'не в полку',
      unknown: 'ник не найден',
      guessed: (rosterNick) => `похоже, это ${rosterNick}`,
      noBattles: 'нет боёв на этом БР',
      reserve: 'запас',
      from: (channel) => `из ${channel}`,
      to: (where) => `→ ${where}`,
      newPlatoon: 'новый взвод',
    },
    classes: { T: 'танк', L: 'лёгкий танк', AA: 'ЗСУ', F: 'самолёт', H: 'вертолёт' },
  },

  playerBoard: {
    title: '📊 Игроки War Thunder',
    footer: 'Δ24ч сравнивается с последним снимком не новее суток',
    unknownPlayer: 'Неизвестный игрок',
    unknownFormat: 'Сохранённые данные имеют неизвестный формат.',
    squadron: (name) => `полк ${name}`,
    noSquadron: 'без полка',
    level: (level) => `ур. ${level}`,
    registered: (date) => `регистрация ${date}`,
    replaysFound: (value) => `реплеев найдено: ${value}`,
    modes: { arcade: 'АБ', realistic: 'РБ', simulation: 'СБ' },
    battles: (value) => `${value} боёв`,
    victories: (value) => `${value} побед`,
    deaths: (value) => `смертей ${value}`,
    targets: (value) => `целей ${value}`,
    delta: (change) => ` (${change}/24ч)`,
    accountStates: {
      fresh: 'аккаунт свежий',
      stale: 'аккаунт устарел',
      pending: 'аккаунт запрашивается',
      empty: 'аккаунт ещё не получен',
      disabled: 'внешний источник выключен',
      disabled_cached: 'кэш внешнего источника',
      private: 'профиль закрыт',
      not_found: 'внешний профиль не найден',
      rate_limited: 'лимит внешнего источника',
      schema_error: 'ошибка формата внешнего источника',
      error: 'ошибка внешнего источника',
    },
    accountBattles: (value) => `боёв на аккаунте: ${value}`,
    accountVictories: (value) => `${value} побед`,
    replayStats: (battles, winRate) => `реплеи: ${battles} боёв · ${winRate}`,
    lookup: {
      ambiguous: 'ник соответствует нескольким известным игрокам',
      unknown: 'игрок ещё не известен',
      error: 'не удалось прочитать',
    },
    statistics: (text) => `🌐 Статистика: ${text}`,
    profileLoading: '⏳ Профиль WT запрашивается…',
    profileUnavailable: '⚪ Профиль WT не запрошен: сессия WT не задана',
    profileError: {
      notFound: '🔴 Профиль WT: игрок не найден',
      session: '🔴 Профиль WT: нужно обновить сессию WT',
      schema: '🔴 Профиль WT: сайт вернул неожиданную страницу',
      other: '🔴 Профиль WT: запрос не удался',
    },
    firstDay: 'Δ24ч: накапливается первый исторический интервал',
    parser: {
      never: '⚪ Парсер ещё не запускался',
      failed: (time) => `🔴 Последнее обновление завершилось ошибкой ${time}; показаны последние данные`,
      partial: (time) => `🟡 Обновление частичное (${time}); часть ников не найдена`,
      stale: (time) => `🟡 Данные давно не проверялись (${time})`,
      fresh: (time) => `🟢 Данные проверены ${time}`,
    },
    voiceIntro:
      'Показываются только игроки, которые сейчас находятся в отслеживаемых голосовых каналах; свежие профили догружаются в фоне.',
    configuredIntro: 'Источник War Thunder обновляется автоматически примерно раз в 30 минут.',
    voiceLoaded: (inVoice, loaded) => `В голосе сейчас ${inVoice}; в табло загружено ${loaded}.`,
    collected: (collected, configured) => `Собрано ${collected} из ${configured} настроенных игроков.`,
    missing: (nicks) => `Нет текущего снимка: ${nicks}.`,
    omitted: (shown, total) => `Показано ${shown} из ${total} игроков из-за лимитов Discord.`,
    emptyVoice: {
      name: 'В голосовых каналах никого нет',
      value: 'Когда игрок зайдёт в отслеживаемый голосовой канал, табло обновится автоматически.',
    },
    emptyConfigured: {
      name: 'Нет данных',
      value: 'Добавьте ники в WT_PLAYER_NAMES и дождитесь успешного запуска wt-players.',
    },
    moved: (channel) => `Табло перенесено в ${channel}. Это сообщение больше не обновляется.`,
    replies: {
      guildOnly: 'Эта команда доступна только на Discord-сервере.',
      badChannel: 'Выбранный канал недоступен или не является текстовым каналом этого сервера.',
      cannotView: (channel) => `Вы сами не видите ${channel}, поэтому не можете поставить туда табло.`,
      permissions: {
        view: 'просмотр канала',
        send: 'отправка сообщений',
        embed: 'встраивание ссылок',
        history: 'чтение истории сообщений',
      },
      missingPermissions: (channel, permissions) => `Боту не хватает прав в ${channel}: ${permissions}.`,
      allVoiceChannels: 'все доступные боту, кроме скрытых от части тех, кто видит табло',
      configured: (channel, url, players, voiceChannels) =>
        `Табло настроено в ${channel}: ${url}\nИгроков в текущем снимке: ${players}.\nГолосовые каналы: ${voiceChannels}.`,
      notConfigured: 'Табло игроков на этом сервере не настроено или отключено.',
      status: (channel, url, voiceChannels) => `Табло включено в ${channel}: ${url}\nГолосовые каналы: ${voiceChannels}.`,
      refreshed: (recreated, url) =>
        `Табло ${recreated ? 'восстановлено' : 'обновлено'} из сохранённых данных: ${url}\n` +
        'Для игроков без свежих данных запрос WT ставится в общую очередь и не блокирует команду.',
      disabled: 'Автоматическое обновление табло отключено. Последнее сообщение оставлено в канале.',
      alreadyDisabled: 'Табло игроков уже отключено или ещё не было настроено.',
      unknownAction: 'Неизвестное действие команды.',
      failed: 'Не удалось выполнить действие с табло. Подробности — в логе бота.',
    },
  },
}
