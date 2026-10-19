import { botText } from '../../i18n/index.js'
import type { Command } from '../types.js'
import { battle } from './battle.js'
import { language } from './language.js'
import { ping } from './ping.js'
import { playerBoard } from './player-board.js'
import { scout } from './scout.js'
import { settings } from './settings.js'
import { stats } from './stats.js'

// A new command goes into this list; the bot registers it on every server at
// its next start (command-sync.ts).
const all: Command[] = [battle, language, ping, playerBoard, scout, settings, stats]

/** By name, which is the same in every language. */
export const commands = new Map<string, Command>(all.map((c) => [c.definition(botText()).name, c]))
