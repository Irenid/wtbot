/**
 * /scout by picture: a scoreboard (Tab) screenshot posted in a channel set with
 * /settings scout is read (src/scout/scoreboard-read.ts) and answered with the enemy's
 * likely setup. Every image, its reading and the prediction (also after the
 * StatShark update) are kept in data/scout-images/ (day folders) to improve the
 * reading and score the replies later (`npm run scout:outcomes`); nothing there
 * is published.
 * One image is read at a time: OCR takes ~1–2 s of CPU.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { EmbedBuilder, type Attachment, type Message } from 'discord.js'
import { writeFileAtomic } from '../atomic-file.js'
import { readResponseBuffer } from '../http-response.js'
import { botText, type BotText } from '../i18n/index.js'
import { formatScoutImageReport, squadronLabel } from '../scout/format.js'
import { OcrUnavailableError } from '../scout/ocr.js'
import { scoutFromImage, scoutPredictionRecord, type ScoutImageOutcome, type ScoutImageReport, type ScoutStatSharkSource } from '../scout/report.js'
import { MAX_IMAGE_BYTES } from '../scout/scoreboard-image.js'
import { isScoutChannel } from './guild-settings.js'
import { guildLocale } from './locale.js'

export const SCOUT_IMAGE_DIR = './data/scout-images'
const MAX_IMAGES_PER_MESSAGE = 4
const MAX_QUEUED = 20
const DOWNLOAD_TIMEOUT_MS = 20_000

let queue: Promise<void> = Promise.resolve()
let queued = 0
/** Replies waiting for StatShark refreshes to be updated; shutdown does not wait for them. */
const updates = new Set<Promise<void>>()
let stopping = false

function imageExtension(attachment: Attachment): 'png' | 'jpg' | null {
  const type = attachment.contentType ?? ''
  const name = attachment.name.toLowerCase()
  if (type === 'image/png' || name.endsWith('.png')) return 'png'
  if (type === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpg'
  return null
}

export function isScoutImageMessage(message: Message): boolean {
  return !message.author.bot
    && message.attachments.some((attachment) => imageExtension(attachment) !== null)
    && isScoutChannel(message.channelId)
}

/** The replies are public: in the server's language (locale.ts). */
function messageText(message: Message): BotText {
  return botText(guildLocale(message.guildId, message.guild?.preferredLocale))
}

/** Resolves once the queued screenshots are answered (shutdown drain); pending StatShark updates are dropped. */
export function scoutImagesIdle(): Promise<void> {
  stopping = true
  return queue
}

/** Queues the message's images; the reply comes when its turn is read, and is updated once StatShark answers (`statShark`). */
export function handleScoutImageMessage(message: Message, statShark: ScoutStatSharkSource | null = null): void {
  if (!isScoutImageMessage(message)) return
  if (queued >= MAX_QUEUED) {
    void message.reply({ content: messageText(message).scout.images.tooMany, allowedMentions: { repliedUser: false } }).catch(() => {})
    return
  }
  queued += 1
  queue = queue
    .then(() => processMessage(message, statShark))
    .catch((error: unknown) => console.error('[scout-images] message failed:', error))
    .finally(() => {
      queued -= 1
    })
}

async function processMessage(message: Message, statShark: ScoutStatSharkSource | null): Promise<void> {
  const images = [...message.attachments.values()].filter((attachment) => imageExtension(attachment) !== null).slice(0, MAX_IMAGES_PER_MESSAGE)
  const text = messageText(message)
  const t = text.scout.images
  if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {})
  const day = new Date(message.createdTimestamp).toISOString().slice(0, 10)
  const dir = path.join(SCOUT_IMAGE_DIR, day)
  await mkdir(dir, { recursive: true })
  for (const [index, attachment] of images.entries()) {
    const base = path.join(dir, `${message.id}-${index}`)
    const record: Record<string, unknown> = {
      messageId: message.id,
      channelId: message.channelId,
      postedAt: new Date(message.createdTimestamp).toISOString(),
      receivedAt: new Date().toISOString(),
      name: attachment.name,
    }
    let reply: string | EmbedBuilder
    let update: Promise<ScoutImageReport> | null = null
    try {
      if (attachment.size > MAX_IMAGE_BYTES) throw new UserFacingError(t.tooLarge)
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading the attachment`)
      const bytes = await readResponseBuffer(response, MAX_IMAGE_BYTES, 'scoreboard screenshot')
      const file = `${base}.${imageExtension(attachment)}`
      await writeFileAtomic(file, bytes)
      record['file'] = path.basename(file)
      const outcome = await scoutFromImage(new Uint8Array(bytes), undefined, statShark)
      record['read'] = outcome.read
      reply = replyFor(outcome, text)
      if (outcome.kind === 'report') {
        record['enemySquadron'] = outcome.report.squadron?.core ?? null
        record['allySquadron'] = outcome.report.allySquadron?.core ?? null
        record['prediction'] = scoutPredictionRecord(outcome.report)
        update = outcome.update
      }
    } catch (error) {
      record['error'] = error instanceof Error ? error.message : String(error)
      reply = error instanceof UserFacingError
        ? error.message
        : error instanceof OcrUnavailableError
          ? t.noOcr
          : t.unreadable
      if (!(error instanceof UserFacingError)) console.error('[scout-images] reading failed:', error)
    }
    await writeFileAtomic(`${base}.json`, JSON.stringify(record, null, 2)).catch((error: unknown) => {
      console.warn('[scout-images] could not save the reading:', error)
    })
    const sent = await message.reply({
      ...(typeof reply === 'string' ? { content: reply } : { embeds: [reply] }),
      allowedMentions: { repliedUser: false },
    })
    if (update) {
      // The reply said StatShark is being checked: it is edited when the refreshes end (or their wait runs out).
      const task: Promise<void> = update
        .then(async (next) => {
          record['predictionUpdated'] = scoutPredictionRecord(next)
          await writeFileAtomic(`${base}.json`, JSON.stringify(record, null, 2)).catch((error: unknown) => {
            console.warn('[scout-images] could not save the updated prediction:', error)
          })
          if (!stopping) await sent.edit({ embeds: [reportEmbed(next, text)] })
        })
        .catch((error: unknown) => console.warn('[scout-images] StatShark update failed:', error))
        .finally(() => updates.delete(task))
      updates.add(task)
    }
  }
}

class UserFacingError extends Error {}

function replyFor(outcome: ScoutImageOutcome, text: BotText): string | EmbedBuilder {
  const t = text.scout.images
  switch (outcome.kind) {
    case 'no-table':
      return t.noTable
    case 'no-players':
      return t.noPlayers
    case 'one-side':
      return t.oneSide(outcome.squadron ? squadronLabel(outcome.squadron.displayTag, outcome.squadron.name) : null)
    case 'report':
      return reportEmbed(outcome.report, text)
  }
}

function reportEmbed(report: ScoutImageReport, text: BotText): EmbedBuilder {
  const formatted = formatScoutImageReport(report, text)
  const embed = new EmbedBuilder().setTitle(formatted.title).setDescription(formatted.description).setColor(formatted.color)
  if (formatted.fields.length > 0) embed.addFields(formatted.fields)
  return embed
}
