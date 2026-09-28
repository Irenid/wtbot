import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BACKUP_LOCK_FILE = '.wtbot-backup.lock'
const MIN_FREE_MARGIN_BYTES = 64n * 1024n * 1024n
/** Незавершённая копия: не совпадает с шаблоном ротации `wtbot-*.db`. */
const TEMP_PREFIX = '.wtbot-backup-'
const TEMP_SUFFIX = '.tmp'

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function normalizedKeep(value: number): number {
  const keep = Number(value)
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
    throw new Error('Количество backup-файлов должно быть целым числом от 1 до 100')
  }
  return keep
}

function availableBytes(outputDir: string): bigint {
  const stats = statfsSync(outputDir, { bigint: true })
  return stats.bavail * stats.bsize
}

function requiredBackupBytes(sourcePath: string): bigint {
  const sourceBytes = statSync(sourcePath, { bigint: true }).size
  return sourceBytes + (sourceBytes / 20n > MIN_FREE_MARGIN_BYTES ? sourceBytes / 20n : MIN_FREE_MARGIN_BYTES)
}

function acquireBackupLock(outputDir: string): () => void {
  const lockPath = path.join(outputDir, BACKUP_LOCK_FILE)
  const ownerToken = randomUUID()
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Backup SQLite уже выполняется: найден lock ${lockPath}`)
    }
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify({ ownerToken, pid: process.pid, createdAt: Date.now() }), 'utf8')
  } catch (error) {
    closeSync(fd)
    rmSync(lockPath, { force: true })
    throw error
  }
  return () => {
    closeSync(fd)
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { ownerToken?: unknown }
      if (parsed.ownerToken === ownerToken) rmSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
}

function collisionError(backupPath: string): Error {
  return new Error(`Backup с таким временем уже существует: ${backupPath}`)
}

/**
 * Остатки прерванных запусков. Вызывается под backup-lock, поэтому других
 * живых записей в каталоге нет и такие файлы точно никому не принадлежат.
 */
function removeStaleTempFiles(outputDir: string): void {
  for (const name of readdirSync(outputDir)) {
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) {
      rmSync(path.join(outputDir, name), { force: true })
    }
  }
}

/**
 * Публикует проверенную копию под итоговым именем, не перезаписывая чужой
 * файл: жёсткая ссылка атомарна и падает с EEXIST, если имя уже занято.
 * На ФС без жёстких ссылок копирует с COPYFILE_EXCL — тоже без перезаписи.
 */
function publishBackup(tempPath: string, backupPath: string): void {
  try {
    linkSync(tempPath, backupPath)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw collisionError(backupPath)
  }
  try {
    copyFileSync(tempPath, backupPath, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw collisionError(backupPath)
    // EXCL гарантирует, что файл создан этим вызовом: неполную копию убираем.
    rmSync(backupPath, { force: true })
    throw error
  }
}

export interface CreateSqliteBackupOptions {
  sourcePath: string
  outputDir?: string | undefined
  keep?: number | undefined
  now?: Date | undefined
  availableBytes?: ((outputDir: string) => bigint) | undefined
}

export function createSqliteBackup(options: CreateSqliteBackupOptions): string {
  const sourcePath = path.resolve(options.sourcePath)
  if (!existsSync(sourcePath)) {
    throw new Error(`Исходная SQLite БД не найдена: ${sourcePath}`)
  }
  const outputDir = path.resolve(options.outputDir ?? path.join(path.dirname(sourcePath), 'backups'))
  const keep = normalizedKeep(options.keep ?? 3)
  mkdirSync(outputDir, { recursive: true })
  const releaseLock = acquireBackupLock(outputDir)
  // Единственный файл, которым владеет вызов до публикации. Итоговое имя
  // никогда не удаляется в catch: при коллизии оно принадлежит прошлой копии.
  let tempPath = ''
  try {
    removeStaleTempFiles(outputDir)
    const requiredBytes = requiredBackupBytes(sourcePath)
    const freeBytes = (options.availableBytes ?? availableBytes)(outputDir)
    if (freeBytes < requiredBytes) {
      throw new Error(
        `Недостаточно свободного места для backup: нужно не менее ${requiredBytes} байт, доступно ${freeBytes}`,
      )
    }

    const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const backupPath = path.join(outputDir, `wtbot-${stamp}.db`)
    if (existsSync(backupPath)) throw collisionError(backupPath)
    tempPath = path.join(outputDir, `${TEMP_PREFIX}${stamp}-${randomUUID()}${TEMP_SUFFIX}`)

    const source = new DatabaseSync(sourcePath, { readOnly: true })
    try {
      source.exec('PRAGMA busy_timeout = 5000;')
      source.exec(`VACUUM INTO ${sqlString(tempPath)}`)
    } finally {
      source.close()
    }

    const backup = new DatabaseSync(tempPath, { readOnly: true })
    try {
      const row = backup.prepare('PRAGMA quick_check').get() as { quick_check: string }
      if (row.quick_check !== 'ok') {
        throw new Error(`Проверка backup не пройдена: ${row.quick_check}`)
      }
    } finally {
      backup.close()
    }

    publishBackup(tempPath, backupPath)
    rmSync(tempPath, { force: true })
    tempPath = ''

    const backups = readdirSync(outputDir)
      .filter((name) => /^wtbot-.*\.db$/u.test(name))
      .sort()
      .reverse()
    for (const name of backups.slice(keep)) {
      rmSync(path.join(outputDir, name), { force: true })
    }
    return backupPath
  } catch (error) {
    if (tempPath !== '') rmSync(tempPath, { force: true })
    throw error
  } finally {
    releaseLock()
  }
}

async function main(): Promise<void> {
  const { config } = await import('../config.js')
  const backupPath = createSqliteBackup({
    sourcePath: config.dbPath,
    outputDir: process.argv[2],
    keep: process.argv[3] === undefined ? undefined : Number(process.argv[3]),
  })
  console.log(`Backup SQLite создан и проверен: ${backupPath}`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
