import type { ParserSource } from '../types.js'
import { wtClanSeason } from './wt-clan-season.js'
import { wtClans } from './wt-clans.js'
import { wtPlayers } from './wt-player.js'
import { wtReplays } from './wt-replays.js'

// Все активные источники: добавил файл с парсером — впиши его сюда.
// Контракт нового источника — AGENTS.md, раздел 6.
export const sources: ParserSource[] = [wtReplays, wtClans, wtPlayers, wtClanSeason]
