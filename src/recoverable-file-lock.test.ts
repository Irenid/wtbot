import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withRecoverableFileLock } from './recoverable-file-lock.js'

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
      pid: process.pid,
      createdAt: Date.now() - 120_000,
    }))
    await assert.rejects(
      withRecoverableFileLock({
        lockFile,
        timeoutMs: 30,
        staleMs: 10,
        retryMinMs: 5,
        retryMaxMs: 5,
      }, async () => undefined),
      /таймаут блокировки файла/,
    )
    assert.equal(existsSync(lockFile), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
