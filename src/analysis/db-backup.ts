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
import { processIsAlive } from '../recoverable-file-lock.js'

export const BACKUP_LOCK_FILE = '.wtbot-backup.lock'
const MIN_FREE_MARGIN_BYTES = 64n * 1024n * 1024n
/**
 * Backup многогигабайтной БД занимает минуты, поэтому lock старше этого срока
 * снимается, даже если PID уже занят другим процессом (Windows переиспользует PID).
 */
const STALE_BACKUP_LOCK_MS = 12 * 60 * 60_000
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

interface BackupLockOwner {
  ownerToken: string
  pid: number
  createdAt: number
}

function parseBackupLockOwner(raw: string): BackupLockOwner | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<BackupLockOwner>
  if (
    typeof candidate.ownerToken !== 'string' ||
    candidate.ownerToken === '' ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid! < 1 ||
    !Number.isSafeInteger(candidate.createdAt) ||
    candidate.createdAt! < 0
  ) {
    return null
  }
  return candidate as BackupLockOwner
}

/**
 * Снимает lock прерванного backup: владелец мёртв или lock старше
 * STALE_BACKUP_LOCK_MS. Повреждённый lock снимается только по возрасту.
 * Отдельный `.recover`-файл не даёт двум запускам одновременно снять lock
 * и удалить уже свежий lock соседа.
 */
function reclaimStaleBackupLock(lockPath: string, isAlive: (pid: number) => boolean): boolean {
  const recoverPath = `${lockPath}.recover`
  let recoverFd: number
  try {
    recoverFd = openSync(recoverPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    let raw: string
    let modifiedAt: number
    try {
      raw = readFileSync(lockPath, 'utf8')
      modifiedAt = statSync(lockPath).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
    const owner = parseBackupLockOwner(raw)
    const ageMs = Date.now() - (owner?.createdAt ?? modifiedAt)
    // Свой PID до захвата lock — это прошлый процесс: в контейнере PID после
    // перезапуска совпадает, а живой backup этого же процесса всегда снимает lock сам.
    const ownerGone = owner !== null && (owner.pid === process.pid || !isAlive(owner.pid))
    const stale = ageMs >= STALE_BACKUP_LOCK_MS || ownerGone
    if (!stale) return false
    rmSync(lockPath, { force: true })
    return true
  } finally {
    closeSync(recoverFd)
    rmSync(recoverPath, { force: true })
  }
}

function openBackupLockFile(lockPath: string, isAlive: (pid: number) => boolean): number {
  try {
    return openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Ровно одно снятие: повторные попытки могли бы снимать свежий lock соседа.
  if (reclaimStaleBackupLock(lockPath, isAlive)) {
    console.warn(`[db-backup] Снят lock прерванного backup: ${lockPath}`)
    try {
      return openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Backup SQLite уже выполняется: найден lock ${lockPath}`)
}

function acquireBackupLock(outputDir: string, isAlive: (pid: number) => boolean): () => void {
  const lockPath = path.join(outputDir, BACKUP_LOCK_FILE)
  const ownerToken = randomUUID()
  const fd = openBackupLockFile(lockPath, isAlive)
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

/** Каталог копий: явный или `backups` рядом с исходной БД. */
export function backupDirFor(sourcePath: string, outputDir?: string): string {
  return path.resolve(outputDir ?? path.join(path.dirname(path.resolve(sourcePath)), 'backups'))
}

/** Время создания самой свежей копии по имени файла (`wtbot-ГГГГММДДTЧЧММССZ.db`) или null. */
export function latestBackupAt(outputDir: string): Date | null {
  let names: string[]
  try {
    names = readdirSync(outputDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let latest: Date | null = null
  for (const name of names) {
    const match = /^wtbot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/u.exec(name)
    if (match === null) continue
    const [, year, month, day, hour, minute, second] = match
    const at = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
    if (!Number.isNaN(at.getTime()) && (latest === null || at > latest)) latest = at
  }
  return latest
}

export interface CreateSqliteBackupOptions {
  sourcePath: string
  outputDir?: string | undefined
  keep?: number | undefined
  now?: Date | undefined
  availableBytes?: ((outputDir: string) => bigint) | undefined
  /** Подмена проверки живости владельца lock для тестов. */
  isProcessAlive?: ((pid: number) => boolean) | undefined
}

export function createSqliteBackup(options: CreateSqliteBackupOptions): string {
  const sourcePath = path.resolve(options.sourcePath)
  if (!existsSync(sourcePath)) {
    throw new Error(`Исходная SQLite БД не найдена: ${sourcePath}`)
  }
  const outputDir = backupDirFor(sourcePath, options.outputDir)
  const keep = normalizedKeep(options.keep ?? 3)
  mkdirSync(outputDir, { recursive: true })
  const releaseLock = acquireBackupLock(outputDir, options.isProcessAlive ?? processIsAlive)
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
  // Пустой каталог (так его передаёт scripts/windows/wtbot-backup.ps1) — каталог по умолчанию рядом с БД.
  const outputDir = process.argv[2]
  const backupPath = createSqliteBackup({
    sourcePath: config.dbPath,
    outputDir: outputDir === undefined || outputDir.trim() === '' ? undefined : outputDir,
    keep: process.argv[3] === undefined ? undefined : Number(process.argv[3]),
  })
  console.log(`Backup SQLite создан и проверен: ${backupPath}`)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
