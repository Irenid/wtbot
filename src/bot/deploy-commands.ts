import { REST, Routes } from 'discord.js'
import { config } from '../config.js'
import { commands } from './commands/index.js'

// Регистрирует slash-команды в Discord. Запуск: npm run deploy:commands
// Достаточно запускать один раз после добавления/изменения команд.

if (!config.clientId) {
  throw new Error('CLIENT_ID не задан в .env — возьми Application ID в Discord Developer Portal (General Information)')
}

const body = [...commands.values()].map((c) => c.data.toJSON())
const rest = new REST().setToken(config.token)

if (config.guildId) {
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body })
  console.log(`Зарегистрировано команд: ${body.length} — на сервере ${config.guildId} (мгновенно)`)
} else {
  await rest.put(Routes.applicationCommands(config.clientId), { body })
  console.log(`Зарегистрировано глобальных команд: ${body.length} (Discord обновляет их до часа)`)
}
