import type { PlayerAccountState } from '../player-stats/comparison.js'
import type { ScoutClass } from '../scout/model.js'
import type { BattleMediaKind } from '../wrpl/battle-media-kind.js'

/**
 * Everything the bot writes to players: Discord replies, posts, embeds,
 * buttons, slash-command descriptions and the text drawn on battle images.
 * Every language implements the whole interface, so a missing translation is
 * a type error. Values are plain text; functions take preformatted numbers,
 * times (`<t:…:R>`) and names, and own the word order and plurals. Markdown
 * markers (`**`) stay with the caller unless a function documents them.
 *
 * Limits a translation must keep (i18n.test.ts checks them): slash-command
 * descriptions ≤ 100 characters; button labels ≤ 80; image texts noted below.
 */
export interface BotText {
  /** BCP 47 tag of numbers, dates and plural rules. */
  intl: string
  /** An integer with this language's digit grouping. */
  number(value: number): string
  /** The language's name in itself ("English", "Русский"): a /language choice. */
  languageName: string

  /**
   * Slash-command descriptions. The bot registers them on every server
   * (src/bot/command-sync.ts): the server's language by default, every
   * catalog's for the users whose Discord language it is.
   */
  commands: {
    battle: { description: string; id: string }
    language: { description: string; language: string }
    ping: { description: string }
    stats: { description: string }
    playerBoard: { description: string; setup: string; channel: string; status: string; refresh: string; disable: string }
    scout: { description: string; squadron: string; player: string }
    settings: {
      description: string
      show: string
      battles: string
      battlesAdd: string
      battlesRemove: string
      scout: string
      scoutAdd: string
      scoutRemove: string
      voice: string
      voiceAdd: string
      voiceRemove: string
      stats: string
      statsSet: string
      statsCategory: string
      statsRemove: string
      platoons: string
      platoonsSet: string
      platoonsRemove: string
      lobby: string
      platoonsChannel: string
      channel: string
      squadron: string
      squadronRemove: string
    }
  }

  /** /language: the server's language. */
  language: {
    guildOnly: string
    /** Confirms the choice, in the chosen language. */
    changed: string
  }

  /** /settings: the server's channels for battle posts, screenshots and the board's voice channels. */
  settings: {
    guildOnly: string
    badChannel: string
    /** The member picked a channel they cannot view (src/bot/access.ts). */
    cannotView(channel: string): string
    /** Discord's own permission names, as the server settings show them. */
    permissions: Record<'view' | 'send' | 'attach' | 'embed' | 'history' | 'manage' | 'connect', string>
    missingPermissions(channel: string, permissions: string): string
    squadronNotFound(query: string): string
    limit(max: number): string
    /** `squadron` null — every squadron's battles. */
    battlesAdded(channel: string, squadron: string | null): string
    battlesExists(channel: string, squadron: string | null): string
    battlesRemoved(channel: string): string
    /** `mentionOnly` — the bot sees attachments only in messages that mention it (no Message Content intent). */
    scoutAdded(channel: string, mentionOnly: boolean): string
    scoutExists(channel: string): string
    scoutRemoved(channel: string): string
    /**
     * `hiddenOnBoard` — some who see the board cannot see the channel, so the board leaves it out;
     * `category` — a category: every voice channel in it, rooms created there later included.
     */
    voiceAdded(channel: string, hiddenOnBoard: boolean, category: boolean): string
    voiceExists(channel: string): string
    /** `othersLeft` false — the board shows every voice channel again. */
    voiceRemoved(channel: string, othersLeft: boolean): string
    notSet(channel: string): string
    /** No category picked and the bot lacks `permissions` on the server (it creates and renames the stats channels). */
    statsNeedsPermissions(permissions: string): string
    /** `squadron` as the game shows it; `category` — the picked category's mention, null — the top of the list. */
    statsSet(squadron: string, category: string | null): string
    statsRemoved: string
    statsNotSet: string
    /** `channel` — where the suggestions are posted. */
    platoonsSet(lobby: string, squadron: string, channel: string): string
    platoonsRemoved: string
    platoonsNotSet: string
    /** Channel names (up to 100 characters); null — the squadron is not on the leaderboard. */
    statsPlaceName(place: number | null): string
    statsPointsName(points: number | null): string
    show: {
      title: string
      language: string
      battles: string
      scout: string
      voice: string
      playerBoard: string
      stats: string
      noStats: string
      platoons: string
      noPlatoons: string
      platoonsValue(lobby: string, squadron: string, channel: string): string
      /** The field listing who can use the commands. */
      access: string
      /** `chosen` false — the default, not a /language choice. */
      languageValue(name: string, chosen: boolean): string
      everySquadron: string
      noBattles: string
      noScout: string
      allVoice: string
      noBoard: string
      missing(permissions: string): string
      /** After a chosen voice channel the board leaves out. */
      hiddenOnBoard: string
      /** After a chosen category: it stands for every voice channel in it. */
      wholeCategory: string
      /** Who the buttons, screenshots and the board serve: Discord's channel access, not the commands'. */
      footer: string
    }
    /**
     * Who can use the commands (src/bot/access.ts): a line is
     * "/a, /b — <audience> · <part> · …"; lists are mentions joined by ", ".
     */
    access: {
      everyone: string
      /** The default of the managers' commands. */
      manageGuild: string
      adminsOnly: string
      /** A default of other permissions than Manage Server. */
      needsPermissions: string
      also(list: string): string
      only(list: string): string
      except(list: string): string
      onlyIn(channels: string): string
      alsoIn(channels: string): string
      notIn(channels: string): string
      noChannel: string
      /** Labels the line of what the server set for all commands at once. */
      everyCommand: string
      /** `bot` — the bot's name in Server Settings → Integrations. */
      note(bot: string): string
      /** Discord did not answer. */
      unread: string
    }
  }

  /** Replies when a handler fails; the error itself goes only to the log. */
  failure: { command: string; battleMedia: string }

  ping(milliseconds: number | null): string

  stats: {
    title: string
    fields: {
      uptime: string
      servers: string
      commandsRun: string
      itemsCollected: string
      season: string
      topCommands: string
      parsers: string
    }
    noCommands: string
    noParsers: string
    uptime(days: number, hours: number, minutes: number, seconds: number): string
    season: {
      noSchedule: string
      ended(time: string): string
      betweenStages: string
      untilEnd: string
      week(week: number): string
      /** The cap that plays now, "10.7". */
      maxBr(br: string): string
      /** The next cap and when it starts to play. */
      nextMaxBr(br: string, time: string): string
      ends(time: string): string
    }
  }

  battle: {
    notFound(id: string): string
    noReplays: string
    noParts: string
    /** Label before the battle's id in posts, chat replies and images. */
    matchId: string
    /** A squadron that played without a tag; also on images. */
    team(number: number): string
    /** The cap the battle played, after its Match ID. */
    maxBr(br: string): string
    /** Under a squadron's players: its place in the warthunder.com squadron ranking. */
    place(place: number): string
    /** Under a squadron's players: its battles won and lost on the battle's UTC day, up to this one. */
    dayRecord(wins: number, losses: number): string
    buttons: {
      replay: string
      chat: string
      log: string
      heatmapGround: string
      heatmapAir: string
      teamGround(squadron: string): string
      teamAir(squadron: string): string
      scaleUp: string
      scaleDown: string
    }
    /** What a failed build could not make, as the object of `buildFailed`. */
    media: Record<BattleMediaKind, string>
    noReplayForHd: string
    noReplayForMedia: string
    buildFailed(media: string, scale: number): string
    /** The CPU pool was full or closing: retrying later helps. */
    buildBusy(media: string, scale: number): string
    hdOverLimitNoCache: string
    hdOverLimit(mebibytes: string): string
    chatTitle: string
    /** The announcement of a battle whose replay never parsed. */
    unparsed: string
  }

  /** Shared by the battle images. */
  image: {
    /** After the date: the battle's length "12:34". */
    duration(time: string): string
    /** A bot's own row (the AI's slot name). */
    bot: string
  }

  /** The results table image (render-battle.ts). */
  scoreboard: {
    victory: string
    unknownPlayer: string
    disconnected: string
    /** After the vehicle when the AI drove the slot; ≤ 6 characters. */
    botDriven: string
  }

  /** The battle log image (render-battle-log.ts). */
  battleLog: {
    title: string
    versus: string
    empty: string
    more(count: number): string
    /**
     * [with an attacker, without one]; drawn between the names: ≤ 16
     * characters at the Latin/Cyrillic width.
     */
    verbs: Record<'kill' | 'fire' | 'severe', readonly [string, string]>
    legend: Record<'kill' | 'fire' | 'severe', string>
    distance(metres: number): string
  }

  /** The heatmap images (render-heatmap.ts). */
  heatmap: {
    /** The mode when the mission name has none. */
    battle: string
    ground: string
    air: string
    /** The team whose routes a team map draws. */
    routes(squadron: string): string
    /**
     * The battle's start in the process time zone; with " · " and `duration`
     * it fits the panel's 420 px at 19 px.
     */
    date(start: Date): string
    duration(time: string): string
    teamSummary(players: number, kills: number, survivors: number): string
    victory: string
    died(time: string): string
    alive: string
    points(score: number): string
    noPaths: string
    legendTitle: string
    /** A column of 174 px at 16.5 px: ≤ 20 characters, measured when changed. */
    legend: {
      path: string
      minute: string
      stop: string
      shot: string
      death: string
      cause: string
      /** The ground map's badge: tank kills have none. */
      causeNotTank: string
      survivor: string
      uav: string
    }
    spawn: Record<SpawnDirection, string>
    /** Death-cause badges: missile seekers and SAMs; ≤ 5 characters. */
    causes: Record<'ir' | 'sarh' | 'arh' | 'sam', string>
  }

  chat: {
    empty: string
    /** By the replay's channel number: team, all, squad, private. */
    channels: readonly [string, string, string, string]
    unknownChannel(channel: number): string
  }

  scout: {
    classCount(cls: ScoutClass, count: number): string
    nobody: string
    groups: Record<ScoutClass | 'unknown', string>
    /** A flag's country from the game's icon id without its era suffix. */
    flag(base: string): string
    plays(chance: string): string
    noBattlesAtBr: string
    likely(vehicles: string): string
    newMark: string
    newVehicle(chance: string): string
    otherNewVehicle(chance: string): string
    nothingStored: string
    lastBattleSession(time: string): string
    lastBattleGuess(time: string, minutes: number): string
    /** `nick` is Markdown-escaped. */
    hintMatched(nick: string): string
    hintMissed(nick: string): string
    basedOn(battles: number, br: string | null): string
    otherGroupTitle: string
    otherGroup(time: string, nicks: string): string
    setupTitle: string
    air(expected: string, chance: string): string
    enemyTeam: string
    readFromScreenshot(read: number, total: number): string
    lastTogether(time: string): string
    chancesWithFlags(br: string | null, countries: string): string
    withoutFlag(count: number): string
    chancesOwn(br: string | null): string
    noneSpawned(br: string | null): string
    flagsUnread(br: string | null): string
    spawnFirst(br: string | null): string
    killsNarrow(count: number): string
    newGuessed(statSharkPlayers: number): string
    statSharkPending: string
    notRecognised(count: number): string
    /** A player guessed behind the game's anonymiser name; both Markdown-escaped. */
    anonymousGuess(nick: string, fakeName: string): string
    choicePlace(place: number): string
    choiceNoBattles: string
    squadronNotFound(query: string): string
    images: {
      tooMany: string
      tooLarge: string
      noOcr: string
      unreadable: string
      noTable: string
      noPlayers: string
      oneSide(squadron: string | null): string
    }
  }

  /**
   * Platoon suggestions (src/bot/platoons.ts): the post that says who of the players in voice should
   * play where. Player names are nicks; no ratings are shown (who is stronger is not posted).
   */
  platoons: {
    /** `cap` — the max BR now, null when unknown. */
    title(squadron: string, cap: number | null): string
    /** How the bot chooses, under the title. */
    intro: string
    /** A room's field name: the channel's name and the squadron's players in it. */
    room(name: string, players: number): string
    /** After the field name of a room short of players. */
    short(missing: number): string
    /** Eight idle players who can form a platoon of their own; `index` from 1 when there are several. */
    newPlatoon(index: number | null): string
    /** Idle players left, fewer than eight: who would form the next platoon. */
    forming(count: number): string
    /** Nobody in the lobby or the rooms. */
    empty: string
    /** Who sits in the lobby but is not placed, and why. */
    notPlaced: string
    /** A swap into a full room; both nicks come bold. */
    swap(inNick: string, outNick: string): string
    tags: {
      deaf: string
      guest: string
      unknown: string
      /** The nick was matched with a typo tolerance. */
      guessed(rosterNick: string): string
      noBattles: string
      /** In a room beyond its eight. */
      reserve: string
      /** Called from a channel (a mention). */
      from(channel: string): string
      /** A room's player suggested elsewhere: a room (a mention) or `newPlatoon`. */
      to(where: string): string
      newPlatoon: string
    }
    classes: Record<ScoutClass, string>
  }

  playerBoard: {
    title: string
    footer: string
    unknownPlayer: string
    unknownFormat: string
    squadron(name: string): string
    noSquadron: string
    level(level: number): string
    registered(date: string): string
    replaysFound(count: string): string
    modes: Record<'arcade' | 'realistic' | 'simulation', string>
    battles(count: string): string
    victories(count: string): string
    deaths(count: string): string
    targets(count: string): string
    /** A signed change over the last day, "+12". */
    delta(change: string): string
    accountStates: Record<PlayerAccountState, string>
    accountBattles(count: string): string
    accountVictories(count: string): string
    replayStats(battles: string, winRate: string): string
    lookup: Record<'ambiguous' | 'unknown' | 'error', string>
    statistics(text: string): string
    profileLoading: string
    profileUnavailable: string
    profileError: Record<PlayerFetchError, string>
    firstDay: string
    parser: {
      never: string
      failed(time: string): string
      partial(time: string): string
      stale(time: string): string
      fresh(time: string): string
    }
    voiceIntro: string
    configuredIntro: string
    voiceLoaded(inVoice: number, loaded: number): string
    collected(collected: number, configured: number): string
    missing(nicks: string): string
    omitted(shown: number, total: number): string
    emptyVoice: { name: string; value: string }
    emptyConfigured: { name: string; value: string }
    moved(channel: string): string
    replies: {
      guildOnly: string
      badChannel: string
      /** The member picked a channel they cannot view (src/bot/access.ts). */
      cannotView(channel: string): string
      permissions: Record<'view' | 'send' | 'embed' | 'history', string>
      missingPermissions(channel: string, permissions: string): string
      allVoiceChannels: string
      configured(channel: string, url: string, players: number, voiceChannels: string): string
      notConfigured: string
      status(channel: string, url: string, voiceChannels: string): string
      refreshed(recreated: boolean, url: string): string
      disabled: string
      alreadyDisabled: string
      unknownAction: string
      failed: string
    }
  }
}

/** Where a team's spawn lies on the map image, from its centre. */
export type SpawnDirection =
  | 'centre'
  | 'right'
  | 'topRight'
  | 'top'
  | 'topLeft'
  | 'left'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight'

/** Why a player's profile could not be read (wt-player.ts error classes). */
export type PlayerFetchError = 'notFound' | 'session' | 'schema' | 'other'
