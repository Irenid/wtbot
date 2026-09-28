import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { latestBackupAt } from './db-backup.js'
import { backupOverdue, msUntilNextRun, parseBackupKeep, parseBackupTime } from './db-backup-schedule.js'

test('время backup: формат ЧЧ:ММ, значение по умолчанию и ошибки', () => {
  assert.deepEqual(parseBackupTime(undefined), { hour: 4, minute: 30 })
  assert.deepEqual(parseBackupTime(' 3:05 '), { hour: 3, minute: 5 })
  assert.deepEqual(parseBackupTime('23:59'), { hour: 23, minute: 59 })
  for (const bad of ['24:00', '12:60', '4', 'ночью']) {
    assert.throws(() => parseBackupTime(bad), /ЧЧ:ММ/, bad)
  }
  assert.equal(parseBackupKeep(undefined), 3)
  assert.equal(parseBackupKeep('7'), 7)
  assert.throws(() => parseBackupKeep('0'), /от 1 до 100/)
})

test('следующий запуск всегда в будущем и не дальше суток', () => {
  const time = { hour: 4, minute: 30 }
  const before = new Date(2026, 8, 28, 3, 0, 0)
  assert.equal(msUntilNextRun(before, time), 90 * 60_000)
  const exactly = new Date(2026, 8, 28, 4, 30, 0)
  assert.equal(msUntilNextRun(exactly, time), 24 * 60 * 60_000)
  const after = new Date(2026, 8, 28, 5, 0, 0)
  assert.equal(msUntilNextRun(after, time), 23.5 * 60 * 60_000)
})

test('просроченный backup определяется по самой свежей копии', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-backup-schedule-'))
  try {
    assert.equal(latestBackupAt(path.join(root, 'missing')), null)
    writeFileSync(path.join(root, 'wtbot-20260927T043000Z.db'), '')
    writeFileSync(path.join(root, 'wtbot-20260928T043000Z.db'), '')
    writeFileSync(path.join(root, '.wtbot-backup-20260929T000000Z-x.tmp'), '')
    writeFileSync(path.join(root, 'notes.txt'), '')
    const latest = latestBackupAt(root)
    assert.equal(latest?.toISOString(), '2026-09-28T04:30:00.000Z')
    assert.equal(backupOverdue(latest, new Date('2026-09-29T04:00:00Z')), false)
    assert.equal(backupOverdue(latest, new Date('2026-09-29T04:30:00Z')), true)
    assert.equal(backupOverdue(null, new Date()), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
