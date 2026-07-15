import type { Command } from '../types.js'
import { battle } from './battle.js'
import { ping } from './ping.js'
import { stats } from './stats.js'

// Реестр команд: написал новую команду — добавь её в этот массив,
// затем запусти `npm run deploy:commands`, чтобы Discord узнал о ней.
const all: Command[] = [battle, ping, stats]

export const commands = new Map<string, Command>(all.map((c) => [c.data.name, c]))
