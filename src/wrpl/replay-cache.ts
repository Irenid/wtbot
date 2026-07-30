import { readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { writeFileAtomic } from '../atomic-file.js'
import { readResponseBuffer } from '../http-response.js'
import {
  ReplayFetchAdmission,
  type ReplayFetchAdmissionSnapshot,
} from './replay-fetch-admission.js'

/** Асинхронный дисковый cache частей replay и вежливое скачивание с CDN. */

const CACHE_DIR = './data/replays'
const REPLAY_CACHE_DAYS = 7
export const REPLAY_FETCH_PAUSE_MS = 150
const FETCH_TIMEOUT_MS = 30_000
export const REPLAY_PART_MAX_BYTES = 96 * 1024 * 1024
const WRPL_HEADER_BYTES = 1234

export interface ReplayFetchAttemptTiming {
  attempt: number
  slotWaitMs: number
  ttfbMs: number | null
  downloadMs: number | null
  retryDelayMs: number
  status: number | null
  bytes: number
}

export interface ReplayPartTiming {
  label: string
  startedAtMs: number
  completedAtMs: number
  totalMs: number
  lockWaitMs: number
  cacheHit: boolean
  cacheInvalid: boolean
  cacheReadMs: number
  cacheWriteMs: number
  bytes: number
  outcome: 'success' | 'error' | 'aborted'
  errorName: string | null
  attempts: ReplayFetchAttemptTiming[]
}

export interface ReplayPartFetchOptions {
  signal?: AbortSignal
  /** Только для изолированных benchmark/smoke; undefined использует production cache. */
  cacheDirectory?: string | null
  memoryReservation?: ReplayPartMemoryReservation
  onTiming?: (timing: ReplayPartTiming) => void
}

export interface ReplayPartMemoryReservation {
  reserve(bytes: number): Promise<void>
  commit(bytes: number): void
  release(): void
}

export function replayFetchAdmissionSnapshot(): ReplayFetchAdmissionSnapshot {
  return replayFetchAdmission.snapshot()
}

export function configureReplayFetchAdmission(enabled: boolean): void {
  replayFetchAdmission.setEnabled(enabled)
}

interface PartLockWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

interface PartLockState {
  locked: boolean
  queue: PartLockWaiter[]
}

type SessionAccess = 'read' | 'write'

interface SessionWaiter extends PartLockWaiter {
  access: SessionAccess
}

interface SessionGate {
  readers: number
  writer: boolean
  queue: SessionWaiter[]
}

let cleanupStarted = false
let lastFetchAt = 0
let fetchNotBeforeAt = 0
let throttleTail: Promise<void> = Promise.resolve()
const replayFetchAdmission = new ReplayFetchAdmission(REPLAY_FETCH_PAUSE_MS)
const partLocks = new Map<string, PartLockState>()
const sessionGates = new Map<string, SessionGate>()

function cacheFileFor(url: string, cacheDirectory: string): string | null {
  const match = /([0-9a-f]{12,20})\/(\d{4}\.wrpl)(?:\?.*)?$/i.exec(url)
  return match ? path.join(cacheDirectory, match[1]!.toLowerCase(), match[2]!) : null
}

export function fetchReplayPart(url: string, options: ReplayPartFetchOptions = {}): Promise<Buffer> {
  const started = performance.now()
  const timing: ReplayPartTiming = {
    label: safeUrlLabel(url),
    startedAtMs: Date.now(),
    completedAtMs: 0,
    totalMs: 0,
    lockWaitMs: 0,
    cacheHit: false,
    cacheInvalid: false,
    cacheReadMs: 0,
    cacheWriteMs: 0,
    bytes: 0,
    outcome: 'error',
    errorName: null,
    attempts: [],
  }
  const cacheDirectory = options.cacheDirectory === undefined ? CACHE_DIR : options.cacheDirectory
  if (cacheDirectory === CACHE_DIR) startCleanup()
  const file = cacheDirectory ? cacheFileFor(url, cacheDirectory) : null
  const session = file ? path.basename(path.dirname(file)) : null
  const lockStarted = performance.now()
  const run = async (): Promise<Buffer> => {
    timing.lockWaitMs = performance.now() - lockStarted
    return doFetchReplayPart(url, file, options.signal, timing, options.memoryReservation)
  }
  const operation = file && session && cacheDirectory
    ? withPartLock(
      path.resolve(file),
      options.signal,
      () => withSessionAccess(
        cacheSessionKey(cacheDirectory, session),
        'read',
        options.signal,
        run,
      ),
    )
    : run()

  return operation.then(
    (data) => {
      timing.bytes = data.byteLength
      timing.outcome = 'success'
      return data
    },
    (error: unknown) => {
      timing.outcome = options.signal?.aborted || isAbortError(error) ? 'aborted' : 'error'
      timing.errorName = error instanceof Error ? error.name : 'Error'
      throw error
    },
  ).finally(() => {
    timing.completedAtMs = Date.now()
    timing.totalMs = performance.now() - started
    emitPartTiming(options.onTiming, timing)
  })
}

async function doFetchReplayPart(
  url: string,
  file: string | null,
  signal: AbortSignal | undefined,
  timing: ReplayPartTiming,
  memoryReservation: ReplayPartMemoryReservation | undefined,
): Promise<Buffer> {
  throwIfAborted(signal)
  if (file) {
    let cached: Buffer | null = null
    let cacheReserved = false
    const readStarted = performance.now()
    try {
      const cachedSize = (await stat(file)).size
      if (cachedSize < WRPL_HEADER_BYTES || cachedSize > REPLAY_PART_MAX_BYTES) {
        timing.cacheInvalid = true
        await rm(file, { force: true }).catch(() => undefined)
      } else {
        await memoryReservation?.reserve(cachedSize)
        cacheReserved = true
        cached = await readFile(file)
      }
    } catch (error) {
      if (cacheReserved) memoryReservation?.release()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      timing.cacheReadMs += performance.now() - readStarted
    }
    throwIfAborted(signal)
    if (cached) {
      try {
        validateReplayPart(cached, `cache ${path.basename(file)}`)
        memoryReservation?.commit(cached.byteLength)
        cacheReserved = false
        timing.cacheHit = true
        timing.bytes = cached.byteLength
        return cached
      } catch {
        if (cacheReserved) {
          memoryReservation?.release()
          cacheReserved = false
        }
        timing.cacheInvalid = true
        // Битый cache удаляем и один раз восстанавливаем с CDN.
        await rm(file, { force: true }).catch(() => undefined)
      }
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    const attemptTiming: ReplayFetchAttemptTiming = {
      attempt,
      slotWaitMs: 0,
      ttfbMs: null,
      downloadMs: null,
      retryDelayMs: 0,
      status: null,
      bytes: 0,
    }
    try {
      attemptTiming.slotWaitMs = await reserveFetchSlot(signal)
      throwIfAborted(signal)
      const fetchStarted = performance.now()
      let response: Response
      try {
        const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
        response = await fetch(url, {
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        })
      } catch (error) {
        if (signal?.aborted) throw abortError()
        throw error
      }
      attemptTiming.ttfbMs = performance.now() - fetchStarted
      attemptTiming.status = response.status
      if (response.ok) {
        const sizeHint = replayPartSizeHint(response)
        try {
          await memoryReservation?.reserve(sizeHint.peakReservationBytes)
        } catch (error) {
          await response.body?.cancel().catch(() => undefined)
          throw error
        }
        let responseReserved = memoryReservation !== undefined
        const downloadStarted = performance.now()
        let data: Buffer
        try {
          data = await readResponseBuffer(response, sizeHint.bodyLimitBytes, 'часть WRPL')
          if (data.byteLength > sizeHint.bodyLimitBytes) {
            throw new Error(
              `часть WRPL: тело ${data.byteLength} байт больше заявленного размера ` +
              `${sizeHint.bodyLimitBytes}`,
            )
          }
          validateReplayPart(data, safeUrlLabel(url))
          memoryReservation?.commit(data.byteLength)
          responseReserved = false
        } finally {
          if (responseReserved) memoryReservation?.release()
          attemptTiming.downloadMs = performance.now() - downloadStarted
        }
        attemptTiming.bytes = data.byteLength
        timing.bytes = data.byteLength
        throwIfAborted(signal)
        if (file) {
          const writeStarted = performance.now()
          try {
            await writeFileAtomic(file, data)
          } finally {
            timing.cacheWriteMs += performance.now() - writeStarted
          }
        }
        replayFetchAdmission.recordSuccess()
        return data
      }
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 429) {
        const delay = retryDelay(response, attempt - 1)
        replayFetchAdmission.recordRateLimit()
        fetchNotBeforeAt = Math.max(fetchNotBeforeAt, Date.now() + delay)
        if (attempt <= 5) {
          const retryStarted = performance.now()
          try {
            await sleep(delay, signal)
          } finally {
            attemptTiming.retryDelayMs = performance.now() - retryStarted
          }
          continue
        }
      }
      throw new Error(`HTTP ${response.status} при скачивании ${safeUrlLabel(url)}`)
    } finally {
      timing.attempts.push(attemptTiming)
    }
  }
}

function replayPartSizeHint(response: Response): {
  bodyLimitBytes: number
  peakReservationBytes: number
} {
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    return {
      bodyLimitBytes: REPLAY_PART_MAX_BYTES,
      peakReservationBytes: REPLAY_PART_MAX_BYTES,
    }
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(declared)
    && declared >= WRPL_HEADER_BYTES
    && declared <= REPLAY_PART_MAX_BYTES) {
    return {
      bodyLimitBytes: declared,
      // readResponseBuffer кратковременно удерживает stream chunks и итоговый
      // Buffer одновременно. Exact-режим учитывает этот peak, но никогда не
      // резервирует больше прежнего conservative worst-case на часть.
      peakReservationBytes: Math.min(REPLAY_PART_MAX_BYTES, declared * 2),
    }
  }
  return {
    bodyLimitBytes: REPLAY_PART_MAX_BYTES,
    peakReservationBytes: REPLAY_PART_MAX_BYTES,
  }
}

function validateReplayPart(data: Buffer, source: string): void {
  if (data.length < WRPL_HEADER_BYTES) throw new Error(`${source}: файл короче заголовка WRPL (${data.length} байт)`)
  if (data.length > REPLAY_PART_MAX_BYTES) throw new Error(`${source}: часть WRPL больше лимита (${data.length} байт)`)
  if (!(data[0] === 0xe5 && data[1] === 0xac && data[2] === 0x00 && data[3] === 0x10)) {
    throw new Error(`${source}: ответ не является WRPL`)
  }
}

function reserveFetchSlot(signal?: AbortSignal): Promise<number> {
  const requestedAt = performance.now()
  const reservation = throttleTail.then(async () => {
    for (;;) {
      throwIfAborted(signal)
      const now = Date.now()
      const deadline = Math.max(
        lastFetchAt + replayFetchAdmission.intervalMs(),
        fetchNotBeforeAt,
      )
      const waitMs = deadline - now
      if (waitMs > 0) {
        await sleep(waitMs, signal)
        continue
      }
      throwIfAborted(signal)
      lastFetchAt = Date.now()
      return performance.now() - requestedAt
    }
  })
  throttleTail = reservation.then(() => undefined, () => undefined)
  return reservation
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000)
  return 700 * (attempt + 1)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function dropReplayCache(sessionIdHex: string): Promise<void> {
  if (!/^[0-9a-f]{12,20}$/i.test(sessionIdHex)) return
  const session = sessionIdHex.toLowerCase()
  const directory = path.resolve(CACHE_DIR, session)
  const root = path.resolve(CACHE_DIR) + path.sep
  if (!directory.startsWith(root)) return
  await withSessionAccess(cacheSessionKey(CACHE_DIR, session), 'write', undefined, () =>
    rm(directory, { recursive: true, force: true }).catch(() => undefined),
  )
}

function startCleanup(): void {
  if (cleanupStarted) return
  cleanupStarted = true
  void cleanupExpired().catch((error: unknown) => {
    console.warn(`[replays] не удалось очистить cache: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function cleanupExpired(): Promise<void> {
  let directories
  try {
    directories = await readdir(CACHE_DIR, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const deadline = Date.now() - REPLAY_CACHE_DAYS * 24 * 3600 * 1000
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^[0-9a-f]{12,20}$/i.test(entry.name)) continue
    const directory = path.join(CACHE_DIR, entry.name)
    await withSessionAccess(cacheSessionKey(CACHE_DIR, entry.name.toLowerCase()), 'write', undefined, async () => {
      try {
        if ((await stat(directory)).mtimeMs < deadline) {
          await rm(directory, { recursive: true, force: true })
          console.log(`[replays] cache частей ${entry.name} старше ${REPLAY_CACHE_DAYS} дн. удалён`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
}

async function withPartLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquirePartLock(key, signal)
  try {
    throwIfAborted(signal)
    return await task()
  } finally {
    release()
  }
}

function acquirePartLock(key: string, signal?: AbortSignal): Promise<() => void> {
  throwIfAborted(signal)
  let state = partLocks.get(key)
  if (!state) {
    state = { locked: false, queue: [] }
    partLocks.set(key, state)
  }
  if (!state.locked && state.queue.length === 0) {
    state.locked = true
    return Promise.resolve(partRelease(key, state))
  }
  return new Promise((resolve, reject) => {
    const waiter: PartLockWaiter = { resolve, reject, ...(signal ? { signal } : {}) }
    if (signal) {
      waiter.onAbort = () => {
        const index = state!.queue.indexOf(waiter)
        if (index >= 0) state!.queue.splice(index, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    state!.queue.push(waiter)
  })
}

function partRelease(key: string, state: PartLockState): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = state.queue.shift()
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
      next.resolve(partRelease(key, state))
      return
    }
    state.locked = false
    if (partLocks.get(key) === state) partLocks.delete(key)
  }
}

async function withSessionAccess<T>(
  key: string,
  access: SessionAccess,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquireSessionAccess(key, access, signal)
  try {
    throwIfAborted(signal)
    return await task()
  } finally {
    release()
  }
}

function acquireSessionAccess(
  key: string,
  access: SessionAccess,
  signal?: AbortSignal,
): Promise<() => void> {
  throwIfAborted(signal)
  let gate = sessionGates.get(key)
  if (!gate) {
    gate = { readers: 0, writer: false, queue: [] }
    sessionGates.set(key, gate)
  }
  if (gate.queue.length === 0 && !gate.writer && (access === 'read' || gate.readers === 0)) {
    if (access === 'read') gate.readers += 1
    else gate.writer = true
    return Promise.resolve(sessionRelease(key, gate, access))
  }
  return new Promise((resolve, reject) => {
    const waiter: SessionWaiter = { access, resolve, reject, ...(signal ? { signal } : {}) }
    if (signal) {
      waiter.onAbort = () => {
        const index = gate!.queue.indexOf(waiter)
        if (index >= 0) gate!.queue.splice(index, 1)
        reject(abortError())
        drainSessionGate(key, gate!)
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    gate!.queue.push(waiter)
  })
}

function sessionRelease(key: string, gate: SessionGate, access: SessionAccess): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    if (access === 'read') gate.readers -= 1
    else gate.writer = false
    drainSessionGate(key, gate)
  }
}

function drainSessionGate(key: string, gate: SessionGate): void {
  if (gate.writer) return
  const first = gate.queue[0]
  if (first?.access === 'write') {
    if (gate.readers > 0) return
    gate.queue.shift()
    grantSessionWaiter(key, gate, first)
    return
  }
  while (gate.queue[0]?.access === 'read' && !gate.writer) {
    const reader = gate.queue.shift()!
    grantSessionWaiter(key, gate, reader)
  }
  if (gate.readers === 0 && !gate.writer && gate.queue.length === 0 && sessionGates.get(key) === gate) {
    sessionGates.delete(key)
  }
}

function grantSessionWaiter(key: string, gate: SessionGate, waiter: SessionWaiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
  if (waiter.access === 'read') gate.readers += 1
  else gate.writer = true
  waiter.resolve(sessionRelease(key, gate, waiter.access))
}

function cacheSessionKey(cacheDirectory: string, session: string): string {
  return `${path.resolve(cacheDirectory)}\u0000${session}`
}

function emitPartTiming(callback: ReplayPartFetchOptions['onTiming'], timing: ReplayPartTiming): void {
  if (!callback) return
  try {
    callback({ ...timing, attempts: timing.attempts.map((attempt) => ({ ...attempt })) })
  } catch {
    // Метрики не должны менять результат загрузки.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(): Error {
  const error = new Error('Загрузка replay отменена')
  error.name = 'AbortError'
  return error
}

function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host}${url.pathname}`
  } catch {
    return 'WRPL CDN'
  }
}
