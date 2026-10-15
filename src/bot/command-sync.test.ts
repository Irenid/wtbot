import assert from 'node:assert/strict'
import test from 'node:test'
import { SlashCommandBuilder } from 'discord.js'
import { botText, LOCALES } from '../i18n/index.js'
import { commandBodies, type CommandBody } from './command-sync.js'
import { commands } from './commands/index.js'
import type { Command } from './types.js'

interface Node {
  name: string
  description?: string
  description_localizations?: Partial<Record<string, string | null>> | null
  options?: Node[]
  choices?: { name: string, value: string | number }[]
}

const list = [...commands.values()]

/** Every described node of a command: the command, its subcommands and options. */
function nodes(node: Node, path = `/${node.name}`): { path: string, node: Node }[] {
  return [{ path, node }, ...(node.options ?? []).flatMap((option) => nodes(option, `${path} ${option.name}`))]
}

/** Discord's 4,000-character cap: names, descriptions and choices of one command in one language. */
function characters(node: Node, description: (node: Node) => string): number {
  return node.name.length + description(node).length +
    (node.choices ?? []).reduce((sum, choice) => sum + choice.name.length + String(choice.value).length, 0) +
    (node.options ?? []).reduce((sum, option) => sum + characters(option, description), 0)
}

test('each server gets its language as the default and every catalog as Discord localizations', () => {
  const en = botText('en')
  const ru = botText('ru')
  for (const locale of LOCALES) {
    const bodies = commandBodies(list, locale)
    assert.deepEqual(bodies.map((body) => body.name), list.map((command) => command.definition(en).name))
    for (const body of bodies) {
      const english = commandBodies(list, 'en').find((other) => other.name === body.name)!
      const russian = commandBodies(list, 'ru').find((other) => other.name === body.name)!
      const englishNodes = nodes(english as Node)
      const russianNodes = nodes(russian as Node)
      for (const [index, { path, node }] of nodes(body as Node).entries()) {
        if (node.description === undefined) continue
        assert.ok(node.description.length >= 1 && node.description.length <= 100, `${locale} ${path}`)
        assert.equal(node.description, (locale === 'en' ? englishNodes : russianNodes)[index]!.node.description, `${locale} ${path}`)
        const localized = node.description_localizations ?? {}
        assert.equal(localized['en-US'], englishNodes[index]!.node.description, `${locale} ${path} en-US`)
        assert.equal(localized['en-GB'], englishNodes[index]!.node.description, `${locale} ${path} en-GB`)
        assert.equal(localized['ru'], russianNodes[index]!.node.description, `${locale} ${path} ru`)
      }
      for (const code of ['en-US', 'ru']) {
        const total = characters(body as Node, (node) => node.description_localizations?.[code] ?? node.description ?? '')
        assert.ok(total <= 4000, `${locale} /${body.name} ${code}: ${total}`)
      }
    }
  }
  assert.notEqual(en.commands.language.description, ru.commands.language.description)
})

test('/language lists each language by its own name, whatever the server\'s language', () => {
  for (const locale of LOCALES) {
    const body = commandBodies(list, locale).find((command) => command.name === 'language') as Node & CommandBody
    assert.equal(body.default_member_permissions, '32', 'Manage Server')
    assert.deepEqual(
      body.options?.[0]?.choices?.map(({ name, value }) => ({ name, value })),
      LOCALES.map((value) => ({ name: botText(value).languageName, value })),
    )
  }
})

test('the same code registers the same body: the stored hash skips unchanged servers', () => {
  for (const locale of LOCALES) {
    assert.equal(JSON.stringify(commandBodies(list, locale)), JSON.stringify(commandBodies(list, locale)))
  }
  assert.notEqual(JSON.stringify(commandBodies(list, 'en')), JSON.stringify(commandBodies(list, 'ru')))
})

test('a command whose languages declare different options is refused', () => {
  const uneven: Command = {
    definition: (t) => {
      const builder = new SlashCommandBuilder().setName('uneven').setDescription(t.commands.ping.description)
      return t === botText('ru')
        ? builder.addStringOption((option) => option.setName('extra').setDescription('x'))
        : builder
    },
    execute: async () => {},
  }
  assert.throws(() => commandBodies([uneven], 'en'), /\/uneven: the languages define different commands/)
})
