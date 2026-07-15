import type { ParserSource } from '../types.js'
import { wtClans } from './wt-clans.js'
import { wtReplays } from './wt-replays.js'

// Все активные источники: добавил файл с парсером — впиши его сюда.
// Скелет нового источника — в README, раздел «Как добавить парсер».
export const sources: ParserSource[] = [wtReplays, wtClans]
