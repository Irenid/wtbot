import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acquireRecoverableFileLock,
  withRecoverableFileLock,
} from './recoverable-file-lock.js'

test('recoverable lock освобождает owned lock после задачи', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    const result = await withRecoverableFileLock({ lockFile }, async () => {
      assert.equal(existsSync(lockFile), true)
      return 'ok'
    })
    assert.equal(result, 'ok')
    assert.equal(existsSync(lockFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock можно удерживать до явного release', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    const lock = await acquireRecoverableFileLock({ lockFile })
    assert.equal(existsSync(lockFile), true)
    await assert.rejects(
      acquireRecoverableFileLock({
        lockFile,
        timeoutMs: 30,
        retryMinMs: 5,
        retryMaxMs: 5,
      }),
      /таймаут блокировки файла/,
    )
    await lock.release()
    assert.equal(existsSync(lockFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock удаляет stale lock мёртвого процесса', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    writeFileSync(lockFile, JSON.stringify({
      ownerToken: 'stale-owner',
      pid: 999_999,
      createdAt: Date.now() - 120_000,
    }))
    let recoveredPid: number | null = null
    await withRecoverableFileLock({
      lockFile,
      staleMs: 60_000,
      isProcessAlive: () => false,
      onRecovered: (_path, owner) => {
        recoveredPid = owner?.pid ?? null
      },
    }, async () => undefined)
    assert.equal(recoveredPid, 999_999)
    assert.equal(existsSync(lockFile), false)
    assert.equal(existsSync(`${lockFile}.recover`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock не удаляет lock живого процесса', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    writeFileSync(lockFile, JSON.stringify({
      ownerToken: 'live-owner',
      pid: 424_242,
      createdAt: Date.now() - 120_000,
    }))
    await assert.rejects(
      withRecoverableFileLock({
        lockFile,
        timeoutMs: 30,
        staleMs: 10,
        retryMinMs: 5,
        retryMaxMs: 5,
        isProcessAlive: (pid) => pid === 424_242,
      }, async () => undefined),
      /таймаут блокировки файла/,
    )
    assert.equal(existsSync(lockFile), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock снимает lock прошлого процесса с тем же PID (перезапуск контейнера)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    // В Docker новый процесс получает тот же PID, что и упавший: владелец «жив» по PID,
    // но ownerToken чужой — это lock прошлого запуска.
    writeFileSync(lockFile, JSON.stringify({
      ownerToken: 'previous-incarnation',
      pid: process.pid,
      createdAt: Date.now() - 120_000,
    }))
    let recovered = false
    await withRecoverableFileLock({
      lockFile,
      staleMs: 10,
      onRecovered: () => {
        recovered = true
      },
    }, async () => undefined)
    assert.equal(recovered, true)
    assert.equal(existsSync(lockFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock не снимает собственный активный lock даже после staleMs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    const lock = await acquireRecoverableFileLock({ lockFile })
    try {
      await assert.rejects(
        acquireRecoverableFileLock({
          lockFile,
          timeoutMs: 30,
          staleMs: 10,
          retryMinMs: 5,
          retryMaxMs: 5,
          // Время ушло далеко вперёд: lock «старый», но его держит этот же процесс.
          now: () => Date.now() + 3_600_000,
        }),
        /таймаут блокировки файла/,
      )
      assert.equal(existsSync(lockFile), true)
    } finally {
      await lock.release()
    }
    assert.equal(existsSync(lockFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable lock удаляет зависший .recover упавшего процесса', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-file-lock-'))
  try {
    const lockFile = path.join(root, 'resource.lock')
    const recoverFile = `${lockFile}.recover`
    writeFileSync(lockFile, JSON.stringify({
      ownerToken: 'dead-owner',
      pid: 999_999,
      createdAt: Date.now() - 120_000,
    }))
    writeFileSync(recoverFile, '{}')
    const old = new Date(Date.now() - 60_000)
    utimesSync(recoverFile, old, old)
    await withRecoverableFileLock({
      lockFile,
      timeoutMs: 2_000,
      staleMs: 10,
      isProcessAlive: () => false,
    }, async () => undefined)
    assert.equal(existsSync(lockFile), false)
    assert.equal(existsSync(recoverFile), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
