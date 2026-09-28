import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { dropBattleArtifacts } from './battle-media.js'

test('повторный ingest удаляет артефакты только своей сессии', async () => {
  const previous = process.cwd()
  const root = mkdtempSync(path.join(tmpdir(), 'wtbot-artifacts-'))
  try {
    process.chdir(root)
    const dir = path.join('data', 'battles')
    mkdirSync(dir, { recursive: true })
    for (const name of [
      '0749dba8001f4b62.png',
      '0749dba8001f4b62-meta.json',
      '0749dba8001f4b62-heatmap-air.png',
      '0749dba8001f4b62-scene-v1.json.gz',
      '0749dba8001f4b63-meta.json',
      'unrelated.txt',
    ]) writeFileSync(path.join(dir, name), 'x')

    await dropBattleArtifacts('0749DBA8001F4B62')
    assert.deepEqual(readdirSync(dir).sort(), ['0749dba8001f4b63-meta.json', 'unrelated.txt'])
    // Некорректный ключ ничего не трогает, отсутствующий каталог — не ошибка.
    await dropBattleArtifacts('../evil')
    assert.equal(readdirSync(dir).length, 2)
    rmSync(dir, { recursive: true })
    await dropBattleArtifacts('0749dba8001f4b63')
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})
