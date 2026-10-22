import { pluralizer } from './plural.js'
import type { BotText } from './types.js'

/**
 * The canonical language: plain English for players who do not know the
 * bot's internals (no jargon, abbreviations or emojis beyond the game's own
 * terms: squadron, PSR, BR, AB/RB/SB).
 */
const plural = pluralizer('en-GB')
const numberFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

const count = (value: number, one: string, other: string): string => `${value} ${plural(value, { one, other })}`
const atBr = (br: string | null): string => (br === null ? '' : ` at BR ${br}`)

const FLAGS: Record<string, string> = {
  usa: 'USA',
  ussr: 'USSR',
  britain: 'Great Britain',
  gdr: 'East Germany',
  republic_china: 'Republic of China',
  uae: 'UAE',
}

export const en: BotText = {
  intl: 'en-GB',
  number: (value) => numberFormat.format(value),
  languageName: 'English',

  commands: {
    battle: {
      description: 'Results of a War Thunder battle as an image',
      id: 'The battle\'s session id (the latest battle by default)',
    },
    language: {
      description: 'Choose the bot\'s language on this server',
      language: 'The language of the bot\'s posts and commands here',
    },
    ping: { description: 'Check that the bot is alive' },
    stats: { description: 'Bot and data collection statistics' },
    playerBoard: {
      description: 'Statistics board of the players in voice channels',
      setup: 'Create the board or move it to another channel',
      channel: 'The channel for the self-updating board',
      status: 'Show where the board is',
      refresh: 'Redraw the board from the stored data',
      disable: 'Stop updating the board',
    },
    scout: {
      description: 'Predict an enemy squadron\'s players and vehicles from its recent battles',
      squadron: 'Squadron tag or name, as the game shows it',
      player: 'A nick you see on the enemy team: picks the right group when two play at once',
    },
    settings: {
      description: 'Choose where the bot posts and what it watches on this server',
      show: 'Show the bot\'s channels, language and who can use its commands here',
      battles: 'Channels for battle posts',
      battlesAdd: 'Post battles in a channel: one squadron\'s, or every squadron\'s',
      battlesRemove: 'Stop battle posts in a channel',
      scout: 'Channels where scoreboard screenshots are read',
      scoutAdd: 'Read scoreboard (Tab) screenshots posted in a channel',
      scoutRemove: 'Stop reading screenshots in a channel',
      voice: 'Voice channels the player board shows',
      voiceAdd: 'Show on the board the players of a voice channel, or of every one in a category',
      voiceRemove: 'Stop showing a voice channel or category on the board',
      stats: 'Channels showing a squadron\'s place and player count',
      statsSet: 'Create two channels with a squadron\'s place and player count',
      statsCategory: 'The category to create them in; empty: the top of the list (needs more permissions)',
      statsRemove: 'Delete the place and player count channels',
      platoons: 'Platoons: the bot suggests who of the players in voice should play',
      platoonsSet: 'Suggest platoons from the players in a voice channel and the rooms beside it',
      platoonsRemove: 'Stop suggesting platoons',
      lobby: 'The voice channel players gather in; the rooms are the voice channels of its category',
      platoonsChannel: 'Where to post the suggestions; empty: the chat of that voice channel',
      channel: 'The channel',
      squadron: 'Squadron tag or name; empty: every squadron\'s battles',
      squadronRemove: 'Only this squadron\'s posts; empty: all of the channel\'s',
    },
  },

  language: {
    guildOnly: 'This command works only on a Discord server.',
    changed:
      'The bot now writes in English on this server: battle posts, the player board and, within a minute, ' +
      'the command descriptions. Replies only you see come in your own Discord language.',
  },

  settings: {
    guildOnly: 'This command works only on a Discord server.',
    badChannel: 'Pick a channel of this server.',
    cannotView: (channel) => `You cannot see ${channel} yourself, so you cannot set the bot up there.`,
    permissions: {
      view: 'View Channel',
      send: 'Send Messages',
      attach: 'Attach Files',
      embed: 'Embed Links',
      history: 'Read Message History',
      manage: 'Manage Channels',
      connect: 'Connect',
    },
    missingPermissions: (channel, permissions) =>
      `The bot lacks ${permissions} in ${channel}. Give them to its role in that channel, then run the command again.`,
    squadronNotFound: (query) => `The bot knows no squadron "${query}". Write the tag as the game shows it.`,
    limit: (max) => `This server already has ${max} such channels. Remove one first.`,
    battlesAdded: (channel, squadron) => squadron === null
      ? `${channel} will get every squadron battle the bot finds: over a thousand posts a day.`
      : `${channel} will get the battles of ${squadron}.`,
    battlesExists: (channel, squadron) => squadron === null
      ? `${channel} already gets every squadron battle.`
      : `${channel} already gets the battles of ${squadron}.`,
    battlesRemoved: (channel) => `${channel} gets no more battle posts.`,
    scoutAdded: (channel, mentionOnly) =>
      `Scoreboard (Tab) screenshots posted in ${channel} will get the enemy's likely players and vehicles.` +
      (mentionOnly ? ' Mention the bot in the message: without that it cannot see the picture.' : ''),
    scoutExists: (channel) => `Screenshots in ${channel} are already read.`,
    scoutRemoved: (channel) => `Screenshots in ${channel} are no longer read.`,
    voiceAdded: (channel, hiddenOnBoard, category) =>
      (category
        ? `The board shows the players of every voice channel in ${channel}, rooms created there later included, ` +
          'and of the other chosen channels only.'
        : `The board shows the players of ${channel}, and of the other chosen voice channels only.`) +
      (hiddenOnBoard ? ' Some who see the board cannot see this channel, so the board leaves it out.' : ''),
    voiceExists: (channel) => `The board already shows ${channel}.`,
    voiceRemoved: (channel, othersLeft) => othersLeft
      ? `The board no longer shows ${channel}.`
      : `The board no longer shows ${channel}: it shows every voice channel the bot can see again, ` +
        'except those some who see the board cannot see.',
    notSet: (channel) => `${channel} was not set up for that.`,
    statsNeedsPermissions: (permissions) =>
      `At the top of the list the bot needs ${permissions} on the server: it creates the channels open to everyone ` +
      'and renames them. Or pick a category where its role has View Channel and Manage Channels.',
    statsSet: (squadron, category) =>
      (category === null
        ? `Two voice channels with the place and player count of ${squadron} are at the top of the channel list ` +
          '(Discord lists text channels outside categories above them): everyone sees them, nobody joins or uses them.'
        : `Two voice channels with the place and player count of ${squadron} are in ${category}, with its permissions: ` +
          'whoever sees the category sees them.') +
      ' They change within a minute of a new leaderboard reading, every 20 minutes at most. ' +
      'Moving or renaming them is fine; deleting one removes both.',
    statsRemoved: 'The place and player count channels are deleted.',
    statsNotSet: 'This server has no place and player count channels.',
    platoonsSet: (lobby, squadron, channel) => `Platoon suggestions are on: the bot watches ${squadron} players in ${lobby} and the voice channels `
      + `beside it and, while someone is there, posts in ${channel} who should play where. It moves nobody.`,
    platoonsRemoved: 'Platoon suggestions are off; their post is deleted.',
    platoonsNotSet: 'Platoon suggestions are not set up on this server.',
    statsPlaceName: (place) => `Squadron place: ${place ?? '–'}`,
    statsMembersName: (members) => `Squadron players: ${members ?? '–'}`,
    show: {
      title: 'The bot on this server',
      language: 'Language',
      battles: 'Battle posts',
      scout: 'Screenshots read in',
      voice: 'Voice channels on the board',
      playerBoard: 'Player board',
      stats: 'Place and rating channels',
      noStats: 'none: /settings stats set',
      platoons: 'Platoons',
      noPlatoons: 'off: /settings platoons set',
      platoonsValue: (lobby, squadron, channel) => `${squadron} in ${lobby}, posted in ${channel}`,
      access: 'Who can use the commands',
      languageValue: (name, chosen) => chosen ? name : `${name} (the default; /language changes it)`,
      everySquadron: 'every squadron',
      noBattles: 'none: /settings battles add',
      noScout: 'none: /settings scout add',
      allVoice: 'every voice channel the bot can see, except those some who see the board cannot see',
      noBoard: 'none: /playerboard setup',
      missing: (permissions) => `⚠ the bot lacks ${permissions}`,
      hiddenOnBoard: '⚠ some who see the board cannot see it: left off the board',
      wholeCategory: '— every voice channel in it',
      footer:
        'Buttons under battle posts answer whoever sees the post. Screenshots are read from whoever can post ' +
        'in the channel. The board leaves out a voice channel that some who see the board cannot see.',
    },
    access: {
      everyone: 'everyone',
      manageGuild: 'members with Manage Server',
      adminsOnly: 'administrators only',
      needsPermissions: 'members with the permissions it asks for',
      also: (list) => `also ${list}`,
      only: (list) => `only ${list}`,
      except: (list) => `not ${list}`,
      onlyIn: (channels) => `only in ${channels}`,
      alsoIn: (channels) => `also in ${channels}`,
      notIn: (channels) => `not in ${channels}`,
      noChannel: 'in no channel',
      everyCommand: 'Every command',
      note: (bot) => `Administrators can use every command. To change who can use one: Server Settings → Integrations → ${bot}.`,
      unread: 'Discord did not say who can use the commands. Try again later.',
    },
  },

  failure: {
    command: 'Something went wrong while running the command.',
    battleMedia: 'Something went wrong while building the battle images.',
  },

  ping: (milliseconds) => `🏓 Pong! WebSocket: ${milliseconds === null ? 'n/a' : `${milliseconds} ms`}`,

  stats: {
    title: '📊 Statistics',
    fields: {
      uptime: 'Uptime',
      servers: 'Servers',
      commandsRun: 'Commands run',
      itemsCollected: 'Items collected',
      season: 'Squadron battles season',
      topCommands: 'Top commands',
      parsers: 'Parsers',
    },
    noCommands: 'none yet',
    noParsers: 'not run yet',
    uptime: (days, hours, minutes, seconds) =>
      [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', `${seconds}s`]
        .filter((part) => part !== '')
        .join(' '),
    season: {
      noSchedule: 'no schedule',
      ended: (time) => `season ended ${time}`,
      betweenStages: 'between stages',
      untilEnd: 'until the end of the season',
      week: (week) => `week ${week}`,
      maxBr: (br) => `max BR ${br}`,
      nextMaxBr: (br, time) => `max BR ${br} ${time}`,
      ends: (time) => `season ends ${time}`,
    },
  },

  battle: {
    notFound: (id) => `No stored replay \`${id}\`.`,
    noReplays: 'No replays stored yet: the parser has not brought any.',
    noParts: 'This item has no links to the replay files.',
    matchId: 'Match ID',
    team: (number) => `Team ${number}`,
    maxBr: (br) => `Max BR ${br}`,
    place: (place) => `#${place}`,
    dayRecord: (wins, losses) => `${wins}W ${losses}L`,
    buttons: {
      replay: 'View Replay',
      chat: 'View Chat',
      log: 'Battle Log',
      heatmapGround: 'Heatmap (gnd)',
      heatmapAir: 'Heatmap (air)',
      teamGround: (squadron) => `${squadron} (gnd)`,
      teamAir: (squadron) => `${squadron} (air)`,
      scaleUp: 'Open at 2×',
      scaleDown: 'Back to 1×',
    },
    media: {
      log: 'the battle log',
      'heatmap-ground': 'the ground vehicles map',
      'heatmap-air': 'the aircraft map',
      'heatmap-team-0': 'the first squadron\'s map',
      'heatmap-team-1': 'the second squadron\'s map',
      'heatmap-team-air-0': 'the first squadron\'s air map',
      'heatmap-team-air-1': 'the second squadron\'s air map',
      chat: 'the chat',
    },
    noReplayForHd: 'This battle\'s replay is not stored, so there is nothing to build the 2× map from.',
    noReplayForMedia: 'This battle\'s replay is not stored, so there is nothing to build from.',
    buildFailed: (media, scale) =>
      `Could not build ${media} at ${scale}×.\nThe replay files may have expired on the CDN (they last about two weeks).`,
    buildBusy: (media, scale) => `The bot is busy and could not build ${media} at ${scale}×. Try again in a minute.`,
    hdOverLimitNoCache: 'The 2× version is over Discord\'s attachment limit, and the 1× version is not cached. Open the map again.',
    hdOverLimit: (mebibytes) => `The 2× version is ${mebibytes} MiB, over Discord's limit; showing the 1× version.`,
    chatTitle: 'Match Chat',
    unparsed: 'The replay could not be parsed.',
  },

  image: {
    duration: (time) => `duration ${time}`,
    bot: 'Bot',
  },

  scoreboard: {
    victory: 'Victory',
    unknownPlayer: 'Unknown Player',
    disconnected: 'Disconnected',
    botDriven: 'bot',
  },

  battleLog: {
    title: 'Battle Log',
    versus: 'vs',
    empty: 'No events found',
    more: (more) => `… ${count(more, 'more event', 'more events')}`,
    verbs: {
      kill: ['destroyed', 'crashed'],
      fire: ['set fire to', 'caught fire'],
      severe: ['badly damaged', 'badly damaged'],
    },
    legend: { kill: 'destroyed', fire: 'set on fire', severe: 'severe damage' },
    distance: (metres) => `${metres} m`,
  },

  heatmap: {
    battle: 'Battle',
    ground: 'ground vehicles',
    air: 'aircraft',
    routes: (squadron) => `routes: ${squadron}`,
    date: (start) => `${dateFormat.format(start)}, ${timeFormat.format(start)}`,
    duration: (time) => `Duration: ${time}`,
    teamSummary: (players, kills, survivors) =>
      `${count(players, 'player', 'players')} · ${count(kills, 'kill', 'kills')} · ${survivors} survived`,
    victory: 'victory',
    died: (time) => `died ${time}`,
    alive: 'alive',
    points: (score) => `${score} pts`,
    noPaths: 'no paths in this mode',
    legendTitle: 'Legend',
    legend: {
      path: 'path',
      minute: 'battle minute',
      stop: 'stop and its length',
      shot: 'killer\'s shot',
      death: 'death (route colour)',
      cause: 'killed by',
      causeNotTank: 'killer if not a tank',
      survivor: 'alive at the end',
      uav: 'drone and its view',
    },
    spawn: {
      centre: 'spawn in the centre',
      right: 'spawn on the right',
      topRight: 'spawn top right',
      top: 'spawn at the top',
      topLeft: 'spawn top left',
      left: 'spawn on the left',
      bottomLeft: 'spawn bottom left',
      bottom: 'spawn at the bottom',
      bottomRight: 'spawn bottom right',
    },
    causes: { ir: 'IR', sarh: 'SARH', arh: 'ARH', sam: 'SAM' },
  },

  chat: {
    empty: 'Nobody wrote in the chat in this battle.',
    channels: ['TEAM', 'ALL', 'SQUAD', 'DM'],
    unknownChannel: (channel) => `UNKNOWN(${channel})`,
  },

  scout: {
    classCount: (cls, value) => {
      switch (cls) {
        case 'F': return `${value} aircraft`
        case 'H': return count(value, 'helicopter', 'helicopters')
        case 'T': return count(value, 'tank', 'tanks')
        case 'L': return count(value, 'light tank', 'light tanks')
        case 'AA': return `${value} anti-air`
      }
    },
    nobody: 'nobody',
    groups: {
      F: 'Aircraft',
      H: 'Helicopters',
      T: 'Tanks',
      L: 'Light tanks',
      AA: 'Anti-air',
      unknown: 'Vehicle unknown',
    },
    flag: (base) => FLAGS[base] ?? base.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
    plays: (chance) => `plays ${chance}`,
    noBattlesAtBr: 'no battles at this BR yet',
    likely: (vehicles) => `no battles at this BR yet, likely ${vehicles}`,
    newMark: 'new',
    newVehicle: (chance) => `new vehicle ${chance}`,
    otherNewVehicle: (chance) => `other new vehicle ${chance}`,
    nothingStored: 'No battles stored in the last two weeks, so there is nothing to predict from.',
    lastBattleSession: (time) => `Last battle ${time}, mid-session: the same players will most likely play.`,
    lastBattleGuess: (time, minutes) =>
      `Last battle ${time}, nothing in the last ${minutes} minutes: the players are a guess from who played recently at this time of day.`,
    hintMatched: (nick) => `Showing the group of **${nick}**.`,
    hintMissed: (nick) => `**${nick}** is not in their recent battles, so this is their latest group.`,
    basedOn: (battles, br) => `Based on ${battles} of their battles${atBr(br)}.`,
    otherGroupTitle: 'Another group is playing at the same time',
    otherGroup: (time, nicks) =>
      `Last battle ${time}: ${nicks}.\nIf you face them, run /scout again with one of these nicks in \`player\`.`,
    setupTitle: 'Most likely setup',
    air: (expected, chance) => `**Air:** ${expected} expected, at least one ${chance}`,
    enemyTeam: 'Enemy team',
    readFromScreenshot: (read, total) => `Read from the screenshot: ${read} of ${total} enemy players.`,
    lastTogether: (time) => `Last played together ${time}.`,
    chancesWithFlags: (br, countries) =>
      `Vehicle chances come from each player's own battles${atBr(br)} and the flags above their team: ${countries}.`,
    withoutFlag: (value) =>
      `${value === 1 ? '1 enemy shows' : `${value} enemies show`} no flag (not spawned yet or destroyed): their chances rest on their battles alone.`,
    chancesOwn: (br) => `Vehicle chances come from each player's own battles${atBr(br)}.`,
    noneSpawned: (br) =>
      `Vehicle chances come from each player's own battles${atBr(br)}. No enemy is in a vehicle yet: a screenshot after they spawn shows their flags and sharpens the guess.`,
    flagsUnread: (br) =>
      `Vehicle chances come from each player's own battles${atBr(br)}. The flags above their team were not read: a screenshot showing them sharpens the guess.`,
    spawnFirst: (br) =>
      `Vehicle chances come from each player's own battles${atBr(br)}. A screenshot after they spawn shows their flags and sharpens the guess.`,
    killsNarrow: (value) =>
      `What ${value === 1 ? '1 enemy has' : `${value} enemies have`} already destroyed or captured narrows their vehicles too.`,
    newGuessed: (players) =>
      `A vehicle not seen from a player at this BR (new) is guessed from what squadrons take at it${
        players > 0 ? ` and their battles on StatShark (${count(players, 'player', 'players')})` : ''
      }.`,
    statSharkPending: 'Checking their battles on StatShark: this reply updates in a minute or two.',
    notRecognised: (value) => `Not recognised · ${value}`,
    anonymousGuess: (nick, fakeName) => `${nick} (probably: hidden as ${fakeName})`,
    choicePlace: (place) => `place ${place}`,
    choiceNoBattles: 'no battles stored',
    squadronNotFound: (query) => `No squadron matches "${query}". Type the tag as the game shows it, for example WLILY.`,
    images: {
      tooMany: 'Too many screenshots at once, try again in a minute.',
      tooLarge: 'The image is over 25 MB.',
      noOcr: 'Reading screenshots is not available on this bot (no OCR installed).',
      unreadable: 'Could not read this screenshot.',
      noTable: 'No scoreboard found. Send a screenshot of the Tab table with both teams.',
      noPlayers: 'No known players found on the scoreboard. A sharper, uncropped screenshot helps; or use /scout with the enemy tag.',
      oneSide: (squadron) =>
        `Only one team could be read (${squadron ?? 'one squadron'}). Enemies are on the right half of the scoreboard: send a screenshot with both teams.`,
    },
  },

  platoons: {
    title: (cap) => `Recommended setups${cap === null ? '' : ` · BR ${cap.toFixed(1)}`}`,
    room: (name, players) => `${name} · ${players}/8`,
    short: (missing) => ` · ${missing} missing`,
    newPlatoon: (index) => `New platoon${index === null ? '' : ` ${index}`} · 8/8, needs a room`,
    forming: (count) => `Next platoon · ${count}/8`,
    empty: 'Nobody is in voice yet.',
    notPlaced: 'Not placed',
    swap: (inNick, outNick) => `${inNick} instead of ${outNick}`,
    tags: {
      deaf: 'deafened',
      guest: 'not in the squadron',
      unknown: 'nick not found',
      guessed: (rosterNick) => `taken for ${rosterNick}`,
      noBattles: 'no battles at this BR',
      reserve: 'reserve',
      from: (channel) => `from ${channel}`,
      to: (where) => `→ ${where}`,
      newPlatoon: 'new platoon',
    },
    classes: { T: 'tank', L: 'light tank', AA: 'SPAA', F: 'aircraft', H: 'helicopter' },
  },

  playerBoard: {
    title: '📊 War Thunder players',
    footer: 'Δ24h compares with the latest snapshot at least a day old',
    unknownPlayer: 'Unknown player',
    unknownFormat: 'The stored data has an unknown format.',
    squadron: (name) => `squadron ${name}`,
    noSquadron: 'no squadron',
    level: (level) => `level ${level}`,
    registered: (date) => `registered ${date}`,
    replaysFound: (value) => `replays found: ${value}`,
    modes: { arcade: 'AB', realistic: 'RB', simulation: 'SB' },
    battles: (value) => `${value} battles`,
    victories: (value) => `${value} victories`,
    deaths: (value) => `deaths ${value}`,
    targets: (value) => `targets ${value}`,
    delta: (change) => ` (${change}/24h)`,
    accountStates: {
      fresh: 'account up to date',
      stale: 'account out of date',
      pending: 'account being requested',
      empty: 'account not received yet',
      disabled: 'external source off',
      disabled_cached: 'external source cache',
      private: 'profile is private',
      not_found: 'external profile not found',
      rate_limited: 'external source limit',
      schema_error: 'external source format error',
      error: 'external source error',
    },
    accountBattles: (value) => `${value} account battles`,
    accountVictories: (value) => `${value} victories`,
    replayStats: (battles, winRate) => `replays: ${battles} battles · ${winRate}`,
    lookup: {
      ambiguous: 'the nick matches several known players',
      unknown: 'the player is not known yet',
      error: 'could not be read',
    },
    statistics: (text) => `🌐 Statistics: ${text}`,
    profileLoading: '⏳ Requesting the WT profile…',
    profileUnavailable: '⚪ WT profile not requested: no WT session is set',
    profileError: {
      notFound: '🔴 WT profile: player not found',
      session: '🔴 WT profile: the WT session needs renewing',
      schema: '🔴 WT profile: the site returned an unexpected page',
      other: '🔴 WT profile: the request failed',
    },
    firstDay: 'Δ24h: the first day of history is still building up',
    parser: {
      never: '⚪ The parser has not run yet',
      failed: (time) => `🔴 The last update failed ${time}; showing the latest data`,
      partial: (time) => `🟡 Partial update (${time}); some nicks were not found`,
      stale: (time) => `🟡 The data has not been checked for a while (${time})`,
      fresh: (time) => `🟢 Data checked ${time}`,
    },
    voiceIntro: 'Only players in the watched voice channels are shown; fresh profiles load in the background.',
    configuredIntro: 'The War Thunder source updates by itself about every 30 minutes.',
    voiceLoaded: (inVoice, loaded) => `In voice now: ${inVoice}; loaded on the board: ${loaded}.`,
    collected: (collected, configured) => `Collected ${collected} of ${configured} configured players.`,
    missing: (nicks) => `No current snapshot: ${nicks}.`,
    omitted: (shown, total) => `Showing ${shown} of ${total} players because of Discord's limits.`,
    emptyVoice: {
      name: 'Nobody is in the voice channels',
      value: 'When a player joins a watched voice channel, the board updates by itself.',
    },
    emptyConfigured: {
      name: 'No data',
      value: 'Add nicks to WT_PLAYER_NAMES and wait for a successful wt-players run.',
    },
    moved: (channel) => `The board moved to ${channel}. This message no longer updates.`,
    replies: {
      guildOnly: 'This command works only on a Discord server.',
      badChannel: 'The chosen channel is unavailable or is not a text channel of this server.',
      cannotView: (channel) => `You cannot see ${channel} yourself, so you cannot put the board there.`,
      permissions: {
        view: 'View Channel',
        send: 'Send Messages',
        embed: 'Embed Links',
        history: 'Read Message History',
      },
      missingPermissions: (channel, permissions) => `The bot lacks permissions in ${channel}: ${permissions}.`,
      allVoiceChannels: 'all the bot can see, except those some who see the board cannot see',
      configured: (channel, url, players, voiceChannels) =>
        `The board is set up in ${channel}: ${url}\nPlayers in the current snapshot: ${players}.\nVoice channels: ${voiceChannels}.`,
      notConfigured: 'The player board is not set up on this server or is disabled.',
      status: (channel, url, voiceChannels) => `The board is on in ${channel}: ${url}\nVoice channels: ${voiceChannels}.`,
      refreshed: (recreated, url) =>
        `The board was ${recreated ? 'restored' : 'updated'} from the stored data: ${url}\nPlayers without fresh data are queued for a WT request without blocking the command.`,
      disabled: 'The board no longer updates. Its last message stays in the channel.',
      alreadyDisabled: 'The player board is already disabled or was never set up.',
      unknownAction: 'Unknown command action.',
      failed: 'Could not complete the board action. The details are in the bot log.',
    },
  },
}
