import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupDirFor, createSqliteBackup, latestBackupAt } from './db-backup.js'

/**
 * Ежедневный backup SQLite для долгоживущего процесса — в Docker это
 * отдельный сервис `backup` в docker-compose.yml (тот же образ и тот же
 * volume с данными). Отдельный процесс не блокирует event loop бота: VACUUM
 * INTO многогигабайтной БД идёт минуты и синхронен.
 *
 * Переменные окружения:
 *   WTBOT_BACKUP_TIME  — ЧЧ:ММ по местному времени процесса (TZ), по умолчанию 04:30;
 *   WTBOT_BACKUP_DIR   — каталог копий, по умолчанию backups рядом с БД;
 *   WTBOT_BACKUP_KEEP  — сколько последних копий хранить, по умолчанию 3.
 * Если свежей копии нет больше суток (первый запуск, простой хоста), backup
 * выполняется сразу при старте, затем — по расписанию.
 */

const DAY_MS = 24 * 60 * 60_000
/** Повтор после ошибки: не ждать сутки, но и не долбить диск. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000

export interface BackupTime {
  hour: number
  minute: number
}

export function parseBackupTime(value: string | undefined): BackupTime {
  const text = (value ?? '').trim() || '04:30'
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(text)
  if (match === null) throw new Error('WTBOT_BACKUP_TIME должен быть в формате ЧЧ:ММ, например 04:30')
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

export function parseBackupKeep(value: string | undefined): number {
  const text = (value ?? '').trim()
  if (text === '') return 3
  const keep = Number(text)
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
    throw new Error('WTBOT_BACKUP_KEEP должен быть целым числом от 1 до 100')
  }
  return keep
}

/** Миллисекунды до ближайшего ЧЧ:ММ по местному времени (строго в будущем). */
export function msUntilNextRun(now: Date, time: BackupTime): number {
  const next = new Date(now)
  next.setHours(time.hour, time.minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

/** Нужен ли backup сразу: копий нет или самая свежая старше суток. */
export function backupOverdue(latest: Date | null, now: Date): boolean {
  return latest === null || now.getTime() - latest.getTime() >= DAY_MS
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} [db-backup-schedule] ${message}`)
}

async function main(): Promise<void> {
  const { config } = await import('../config.js')
  const time = parseBackupTime(process.env['WTBOT_BACKUP_TIME'])
  const keep = parseBackupKeep(process.env['WTBOT_BACKUP_KEEP'])
  const configuredDir = process.env['WTBOT_BACKUP_DIR']?.trim()
  const outputDir = backupDirFor(config.dbPath, configuredDir === '' ? undefined : configuredDir)
  let timer: NodeJS.Timeout | null = null
  let stopping = false

  const stop = (signal: string) => {
    stopping = true
    if (timer !== null) clearTimeout(timer)
    log(`получен ${signal} — останавливаюсь`)
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))

  const schedule = (delayMs: number) => {
    if (stopping) return
    const at = new Date(Date.now() + delayMs)
    log(`следующий backup: ${at.toISOString()}`)
    timer = setTimeout(run, delayMs)
  }

  const run = () => {
    timer = null
    if (stopping) return
    const started = Date.now()
    try {
      const backupPath = createSqliteBackup({ sourcePath: config.dbPath, outputDir, keep })
      log(`backup создан и проверен за ${Math.round((Date.now() - started) / 1_000)} с: ${backupPath}`)
      schedule(msUntilNextRun(new Date(), time))
    } catch (error) {
      log(`backup не выполнен: ${error instanceof Error ? error.message : String(error)}`)
      schedule(RETRY_AFTER_FAILURE_MS)
    }
  }

  log(
    `БД ${path.resolve(config.dbPath)}, копии в ${outputDir}, хранить ${keep}, ` +
      `ежедневно в ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
  )
  if (backupOverdue(latestBackupAt(outputDir), new Date())) {
    log('свежей копии нет больше суток — делаю backup сейчас')
    run()
  } else {
    schedule(msUntilNextRun(new Date(), time))
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
