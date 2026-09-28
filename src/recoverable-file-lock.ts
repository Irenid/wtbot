import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

interface LockOwner {
  ownerToken: string
  pid: number
  createdAt: number
}

export interface OwnedFileLock {
  release(): Promise<void>
}

/** Lock держит живой владелец дольше timeoutMs — отличается от ошибок файловой системы. */
export class FileLockTimeoutError extends Error {
  readonly lockFile: string

  constructor(lockFile: string) {
    super(`таймаут блокировки файла: ${lockFile}`)
    this.name = 'FileLockTimeoutError'
    this.lockFile = lockFile
  }
}

export interface RecoverableFileLockOptions {
  lockFile: string
  timeoutMs?: number | undefined
  staleMs?: number | undefined
  retryMinMs?: number | undefined
  retryMaxMs?: number | undefined
  now?: (() => number) | undefined
  isProcessAlive?: ((pid: number) => boolean) | undefined
  onRecovered?: ((lockFile: string, owner: LockOwner | null) => void) | undefined
}

/**
 * ownerToken lock-файлов, которыми сейчас владеет этот процесс. Lock с нашим
 * PID, но чужим токеном оставлен прошлым процессом: в Docker после перезапуска
 * контейнера node почти всегда получает тот же PID (часто 1), и без этой
 * проверки такой lock считался бы живым вечно — бот не смог бы стартовать.
 */
const ownedTokens = new Set<string>()
/** `.recover` держится миллисекунды; старше этого срока он остался от упавшего процесса. */
const RECOVER_GUARD_STALE_MS = 10_000

function parseOwner(value: unknown): LockOwner | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Partial<LockOwner>
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
  return candidate as LockOwner
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readOwner(filePath: string): Promise<{ owner: LockOwner | null; modifiedAt: number } | null> {
  try {
    const [raw, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Повреждённый metadata-файл можно reclaim только после stale timeout.
    }
    return { owner: parseOwner(parsed), modifiedAt: stats.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function createOwnedLock(filePath: string, now: () => number): Promise<OwnedFileLock> {
  const handle = await open(filePath, 'wx', 0o600)
  const owner: LockOwner = { ownerToken: randomUUID(), pid: process.pid, createdAt: now() }
  ownedTokens.add(owner.ownerToken)
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8')
    await handle.sync()
  } catch (error) {
    ownedTokens.delete(owner.ownerToken)
    await handle.close().catch(() => undefined)
    await rm(filePath, { force: true }).catch(() => undefined)
    throw error
  }
  return {
    async release() {
      ownedTokens.delete(owner.ownerToken)
      await handle.close().catch(() => undefined)
      try {
        const current = parseOwner(JSON.parse(await readFile(filePath, 'utf8')))
        if (current?.ownerToken === owner.ownerToken) await rm(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
    },
  }
}

async function staleOwner(
  filePath: string,
  staleMs: number,
  now: () => number,
  isProcessAlive: (pid: number) => boolean,
): Promise<LockOwner | null | false> {
  const state = await readOwner(filePath)
  if (state === null) return false
  const createdAt = state.owner?.createdAt ?? state.modifiedAt
  if (now() - createdAt < staleMs) return false
  if (state.owner !== null) {
    const previousIncarnation = state.owner.pid === process.pid && !ownedTokens.has(state.owner.ownerToken)
    if (!previousIncarnation && isProcessAlive(state.owner.pid)) return false
  }
  return state.owner
}

/**
 * true — reclaim уже идёт в другом процессе. Зависший `.recover` (процесс
 * упал в миллисекундном окне reclaim) удаляется по возрасту, иначе lock
 * нельзя было бы снять никогда.
 */
async function recoverGuardActive(recoverFile: string, now: () => number): Promise<boolean> {
  let modifiedAt: number
  try {
    modifiedAt = (await stat(recoverFile)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (now() - modifiedAt < RECOVER_GUARD_STALE_MS) return true
  await rm(recoverFile, { force: true })
  return false
}

async function tryReclaim(
  lockFile: string,
  staleMs: number,
  now: () => number,
  isProcessAlive: (pid: number) => boolean,
  onRecovered: ((lockFile: string, owner: LockOwner | null) => void) | undefined,
): Promise<boolean> {
  const recoverFile = `${lockFile}.recover`
  let recoverLock: OwnedFileLock
  try {
    recoverLock = await createOwnedLock(recoverFile, now)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }

  try {
    const owner = await staleOwner(lockFile, staleMs, now, isProcessAlive)
    if (owner === false) return false
    await rm(lockFile, { force: true })
    onRecovered?.(lockFile, owner)
    return true
  } finally {
    await recoverLock.release()
  }
}

export async function acquireRecoverableFileLock(
  options: RecoverableFileLockOptions,
): Promise<OwnedFileLock> {
  const lockFile = path.resolve(options.lockFile)
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 60_000
  const retryMinMs = options.retryMinMs ?? 25
  const retryMaxMs = options.retryMaxMs ?? 75
  const now = options.now ?? Date.now
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs должен быть положительным')
  if (!Number.isFinite(staleMs) || staleMs < 1) throw new RangeError('staleMs должен быть положительным')
  if (
    !Number.isFinite(retryMinMs) ||
    !Number.isFinite(retryMaxMs) ||
    retryMinMs < 1 ||
    retryMaxMs < retryMinMs
  ) {
    throw new RangeError('Некорректный диапазон retry для file lock')
  }

  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 })
  const deadline = now() + timeoutMs
  let ownedLock: OwnedFileLock | null = null
  for (;;) {
    if (!(await recoverGuardActive(`${lockFile}.recover`, now))) {
      try {
        ownedLock = await createOwnedLock(lockFile, now)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (await tryReclaim(lockFile, staleMs, now, isProcessAlive, options.onRecovered)) continue
    }
    if (now() >= deadline) throw new FileLockTimeoutError(lockFile)
    const waitMs = retryMinMs + Math.floor(Math.random() * (retryMaxMs - retryMinMs + 1))
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, waitMs))
  }

  return ownedLock
}

export async function withRecoverableFileLock<T>(
  options: RecoverableFileLockOptions,
  task: () => Promise<T>,
): Promise<T> {
  const ownedLock = await acquireRecoverableFileLock(options)
  try {
    return await task()
  } finally {
    await ownedLock.release()
  }
}
