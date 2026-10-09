/**
 * /scout by picture: a scoreboard (Tab) screenshot posted in a WT_SCOUT_CHANNEL
 * channel is read (src/scout/scoreboard-read.ts) and answered with the enemy's
 * likely setup. Every image and its reading are kept in data/scout-images/
 * (day folders) to improve the reading later; nothing there is published.
 * One image is read at a time: OCR takes ~1–2 s of CPU.
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { EmbedBuilder, type Attachment, type Message } from 'discord.js'
import { writeFileAtomic } from '../atomic-file.js'
import { config } from '../config.js'
import { readResponseBuffer } from '../http-response.js'
import { formatScoutImageReport, squadronLabel } from '../scout/format.js'
import { OcrUnavailableError } from '../scout/ocr.js'
import { scoutFromImage, type ScoutImageOutcome, type ScoutImageReport, type ScoutStatSharkSource } from '../scout/report.js'
import { MAX_IMAGE_BYTES } from '../scout/scoreboard-image.js'

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
    && config.scoutChannelIds.includes(message.channelId)
    && message.attachments.some((attachment) => imageExtension(attachment) !== null)
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
    void message.reply({ content: 'Too many screenshots at once, try again in a minute.', allowedMentions: { repliedUser: false } }).catch(() => {})
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
  if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {})
  const day = new Date(message.createdTimestamp).toISOString().slice(0, 10)
  const dir = path.join(SCOUT_IMAGE_DIR, day)
  await mkdir(dir, { recursive: true })
  for (const [index, attachment] of images.entries()) {
    const base = path.join(dir, `${message.id}-${index}`)
    const record: Record<string, unknown> = { messageId: message.id, channelId: message.channelId, receivedAt: new Date().toISOString(), name: attachment.name }
    let reply: string | EmbedBuilder
    let update: Promise<ScoutImageReport> | null = null
    try {
      if (attachment.size > MAX_IMAGE_BYTES) throw new UserFacingError('The image is over 25 MB.')
      const response = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading the attachment`)
      const bytes = await readResponseBuffer(response, MAX_IMAGE_BYTES, 'scoreboard screenshot')
      const file = `${base}.${imageExtension(attachment)}`
      await writeFileAtomic(file, bytes)
      record['file'] = path.basename(file)
      const outcome = await scoutFromImage(new Uint8Array(bytes), undefined, statShark)
      record['read'] = outcome.read
      reply = replyFor(outcome)
      if (outcome.kind === 'report') {
        record['enemySquadron'] = outcome.report.squadron?.core ?? null
        record['allySquadron'] = outcome.report.allySquadron?.core ?? null
        update = outcome.update
      }
    } catch (error) {
      record['error'] = error instanceof Error ? error.message : String(error)
      reply = error instanceof UserFacingError
        ? error.message
        : error instanceof OcrUnavailableError
          ? 'Reading screenshots is not available on this bot (no OCR installed).'
          : 'Could not read this screenshot.'
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
          if (!stopping) await sent.edit({ embeds: [reportEmbed(next)] })
        })
        .catch((error: unknown) => console.warn('[scout-images] StatShark update failed:', error))
        .finally(() => updates.delete(task))
      updates.add(task)
    }
  }
}

class UserFacingError extends Error {}

function replyFor(outcome: ScoutImageOutcome): string | EmbedBuilder {
  switch (outcome.kind) {
    case 'no-table':
      return 'No scoreboard found. Send a screenshot of the Tab table with both teams.'
    case 'no-players':
      return 'No known players found on the scoreboard. A sharper, uncropped screenshot helps; or use /scout with the enemy tag.'
    case 'one-side': {
      const name = outcome.squadron ? squadronLabel(outcome.squadron.displayTag, outcome.squadron.name) : 'one squadron'
      return `Only one team could be read (${name}). Enemies are on the right half of the scoreboard: send a screenshot with both teams.`
    }
    case 'report':
      return reportEmbed(outcome.report)
  }
}

function reportEmbed(report: ScoutImageReport): EmbedBuilder {
  const text = formatScoutImageReport(report)
  const embed = new EmbedBuilder().setTitle(text.title).setDescription(text.description).setColor(text.color)
  if (text.fields.length > 0) embed.addFields(text.fields)
  return embed
}
